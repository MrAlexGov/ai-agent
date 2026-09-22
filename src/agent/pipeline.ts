import type { Store } from '../storage/types';
import { detectIntent, extractContact, looksLikeContact } from './intents';
import { generateAnswer } from './brain';
import type { Intent } from './intents';
import { config } from '../config';

/**
 * Конвейер обработки сообщения клиента (этапы 4–6 из AGENTS.md):
 *   память -> режим чата -> интент -> ответ/заявка/эскалация -> уведомление владельца.
 * Транспорт (Telegram) внедряется снаружи, чтобы не тянуть Telegraf в логику.
 */

export interface ClientInfo {
  chatId: string;
  name: string | null;
  username: string | null;
}

export interface PipelineTransport {
  /** Сообщение клиенту от бота/менеджера */
  send(chatId: string, text: string): Promise<void>;
  /** Личное уведомление владельцу */
  notifyOwner(text: string): Promise<void>;
}

const INTENT_TOPIC: Record<Intent, string> = {
  greeting: 'Приветствие',
  pricing: 'Вопрос по ценам',
  faq: 'Вопрос по компании',
  lead: 'Заявка на услугу',
  escalation: 'Запрос менеджера',
  smalltalk: 'Свободный вопрос',
};

export function createPipeline(store: Store, transport: PipelineTransport) {
  /** Основной вход: клиент прислал сообщение в личку бота. */
  async function handleUserMessage(info: ClientInfo, text: string): Promise<void> {
    await store.upsertUser({ chatId: info.chatId, name: info.name, username: info.username });
    await store.saveMessage({ chatId: info.chatId, role: 'user', text });

    const mode = await store.getChatMode(info.chatId);

    if (mode === 'human') {
      // Идёт живой диалог: бот молчит, владелец отвечает через дашборд/Telegram.
      return;
    }

    if (mode === 'contact') {
      await collectContact(info, text);
      return;
    }

    const intent = detectIntent(text);
    switch (intent) {
      case 'greeting': {
        await botSay(info.chatId, helloText());
        return;
      }
      case 'escalation': {
        await escalate(info, text, 'Клиент просит человека / недоволен');
        return;
      }
      case 'lead': {
        const contact = extractContact(text);
        if (contact) {
          await createLeadTicket(info, contact, text);
        } else {
          await store.setChatMode(info.chatId, 'contact');
          await botSay(
            info.chatId,
            'Отлично, помогу оформить заявку! 📝\n' +
              'Напишите контакт для связи: телефон, email или @юзернейм в Telegram.\n' +
              'Либо позовите менеджера сразу — /handoff'
          );
        }
        return;
      }
      default: {
        // pricing / faq / smalltalk — отвечает мозг (БЗ + опц. LLM)
        const history = await store.getHistory(info.chatId, 12);
        const answer = await generateAnswer(text, history.slice(0, -1));
        await botSay(info.chatId, answer.text);
      }
    }
  }

  /** Режим «ждём контакт» для заявки. */
  async function collectContact(info: ClientInfo, text: string): Promise<void> {
    if (looksLikeContact(text)) {
      const contact = extractContact(text) ?? text.trim().slice(0, 120);
      await createLeadTicket(info, contact, text);
      return;
    }
    if (/менеджер|человек|handoff|не буду|позже|передумал/i.test(text)) {
      await escalate(info, text, 'Клиент не оставил контакт, просит менеджера');
      return;
    }
    await botSay(
      info.chatId,
      'Не распознал контакт 🙏 Напишите, пожалуйста, одним сообщением:\n' +
        '• телефон, например +7 999 123-45-67\n' +
        '• email, например ivan@mail.ru\n' +
        '• @юзернейм в Telegram\n' +
        'Или позовите менеджера — /handoff'
    );
  }

  async function createLeadTicket(info: ClientInfo, contact: string, sourceText: string): Promise<void> {
    const history = await store.getHistory(info.chatId, 6);
    const topic = buildTopic(history);
    const ticket = await store.createTicket({
      chatId: info.chatId,
      kind: 'lead',
      userName: info.name,
      username: info.username,
      contact,
      topic,
    });
    await store.upsertUser({ chatId: info.chatId, phone: /^@/.test(contact) ? null : contact });
    await store.setChatMode(info.chatId, 'bot');
    await store.saveMessage({
      chatId: info.chatId,
      role: 'bot',
      text: `Заявка №${ticket.id} принята ✅`,
    });
    await transport.send(
      info.chatId,
      `Заявка №${ticket.id} принята ✅\n` +
        `Тема: ${topic}\nКонтакт: ${contact}\n\n` +
        `${INTENT_TOPIC.lead}: менеджер свяжется с вами в рабочее время (9:00–21:00 МСК).`
    );
    await notifyOwnerTicket(ticket.id, info, 'lead', topic, contact, sourceText);
  }

  /** Эскалация: тикет handoff + владелец в Telegram + бот замолкает в чате. */
  async function escalate(info: ClientInfo, sourceText: string, reason: string): Promise<void> {
    const history = await store.getHistory(info.chatId, 6);
    const topic = buildTopic(history);
    const ticket = await store.createTicket({
      chatId: info.chatId,
      kind: 'handoff',
      userName: info.name,
      username: info.username,
      contact: extractContact(sourceText),
      topic,
    });
    await store.setChatMode(info.chatId, 'human');
    await store.saveMessage({
      chatId: info.chatId,
      role: 'bot',
      text: 'Передал диалог менеджеру',
    });
    await transport.send(
      info.chatId,
      'Передаю диалог живому менеджеру 👨‍💼\n' +
        'Он ответит здесь же в чате. Если удобнее — можно оставить контакт и менеджер свяжется сам.'
    );
    await notifyOwnerTicket(ticket.id, info, 'handoff', `${reason}. ${topic}`, null, sourceText);
  }

  /** Ответ владельца клиенту из дашборда (этап 6). */
  async function ownerReply(ticketId: number, text: string): Promise<void> {
    const ticket = await store.getTicket(ticketId);
    if (!ticket) throw new Error(`Заявка ${ticketId} не найдена`);
    if (ticket.status === 'done') throw new Error('Заявка закрыта — создайте новую через диалог');

    const msg = `👩‍💼 Менеджер «${ticket.topic ?? 'вопроса'}»:\n${text}`;
    await transport.send(ticket.chatId, msg);
    await store.saveMessage({ chatId: ticket.chatId, role: 'owner', text });
    if (ticket.status === 'new') {
      await store.updateTicket(ticketId, { status: 'in_progress' });
    }
  }

  /** Закрытие заявки: бот снова включается в чате и сообщает об этом клиенту. */
  async function closeTicket(ticketId: number): Promise<void> {
    const ticket = await store.getTicket(ticketId);
    if (!ticket) throw new Error(`Заявка ${ticketId} не найдена`);
    await store.updateTicket(ticketId, { status: 'done' });
    const mode = await store.getChatMode(ticket.chatId);
    if (ticket.kind === 'handoff' && mode === 'human') {
      await store.setChatMode(ticket.chatId, 'bot');
      await store.saveMessage({
        chatId: ticket.chatId,
        role: 'bot',
        text: 'Заявка закрыта, я снова на связи',
      });
      await transport.send(
        ticket.chatId,
        'Заявка закрыта ✅ Я снова на связи! Если понадобится помощь — просто напишите.'
      );
    }
  }

  // ---------- служебные ----------

  async function botSay(chatId: string, text: string): Promise<void> {
    await store.saveMessage({ chatId, role: 'bot', text });
    await transport.send(chatId, text);
  }

  async function notifyOwnerTicket(
    ticketId: number,
    info: ClientInfo,
    kind: 'lead' | 'handoff',
    topic: string,
    contact: string | null,
    sourceText: string
  ): Promise<void> {
    const icon = kind === 'lead' ? '🧾 Новая заявка' : '🚨 Эскалация';
    const who = [info.name, info.username ? `@${info.username}` : null].filter(Boolean).join(' ');
    await transport.notifyOwner(
      `${icon} #${ticketId}\n` +
        `Тема: ${topic}\n` +
        `Клиент: ${who || 'без имени'} (чат ${info.chatId})\n` +
        (contact ? `Контакт: ${contact}\n` : '') +
        `Сообщение: «${sourceText.slice(0, 300)}»\n` +
        `Ответить: дашборд -> заявка #${ticketId}`
    );
  }

  /** Тема заявки: последнее осмысленное сообщение клиента, обрезанное до 80 символов. */
  function buildTopic(history: Awaited<ReturnType<Store['getHistory']>>): string {
    const userMsgs = history.filter((m) => m.role === 'user').map((m) => m.text.trim());
    const last = userMsgs[userMsgs.length - 1] ?? 'Без описания';
    const oneLine = last.replace(/\s+/g, ' ');
    return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
  }

  function helloText(): string {
    return (
      `Здравствуйте! 👋 Я AI-ассистент «${config.businessName}».\n` +
      'Помогу с вопросами о компании, ценах и услугах.\n\n' +
      'Команды:\n' +
      '/menu — меню с быстрыми кнопками\n' +
      '/handoff — позвать живого менеджера\n' +
      '/help — помощь'
    );
  }

  return {
    handleUserMessage,
    ownerReply,
    closeTicket,
  };
}

export type Pipeline = ReturnType<typeof createPipeline>;
