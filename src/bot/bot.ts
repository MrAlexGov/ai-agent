import { Telegraf, Markup, Context } from 'telegraf';
import type { Store } from '../storage/types';
import type { Auth, TgUser } from '../auth/auth';
import { createPipeline } from '../agent/pipeline';
import { config } from '../config';

/**
 * Telegram-слой (этап 1): команды, инлайн-меню, приём сообщений,
 * уведомления владельцу. Бизнес-логика — в pipeline, здесь только транспорт.
 * Плюс подтверждение входа в админку: /login КОД или /start login_КОД.
 */

export interface BotHandle {
  /** Отправка произвольного сообщения клиенту (для дашборда). */
  sendTo(chatId: string, text: string): Promise<void>;
  /** Уведомление владельцу в личку. */
  notifyOwner(text: string): Promise<void>;
  /** @username бота — для deep-link входа в админку (t.me/<bot>?start=login_КОД). */
  username: string;
  stop(): Promise<void>;
}

export async function createBot(store: Store, auth: Auth): Promise<BotHandle> {
  if (!config.botToken) {
    throw new Error('BOT_TOKEN не задан: скопируйте .env.example в .env и вставьте токен от @BotFather');
  }

  const bot = new Telegraf(config.botToken);
  const me = await bot.telegram.getMe(); // сразу проверяем валидность токена

  const transport = {
    send: async (chatId: string, text: string) => {
      await bot.telegram.sendMessage(chatId, text);
    },
    notifyOwner: async (text: string) => {
      if (!config.ownerId) {
        console.warn('[bot] OWNER_TELEGRAM_ID не задан — уведомление не отправлено:\n', text);
        return;
      }
      await bot.telegram.sendMessage(config.ownerId, text);
    },
  };
  const pipeline = createPipeline(store, transport);

  // ---------- Команды ----------

  bot.start(async (ctx) => {
    // Deep-link входа в админку: t.me/<bot>?start=login_КОД
    const payload = (ctx.startPayload ?? '').trim();
    if (payload.toLowerCase().startsWith('login_')) {
      await handleLogin(ctx, payload.slice('login_'.length));
      return;
    }
    const info = clientOf(ctx);
    if (!info) return;
    await ctx.reply(
      `Привет! 👋 Я AI-агент — консультирую о себе самом:\n` +
        `что умею, чего не умею, как меня настроить и задеплоить.\n\n` +
        `Меню — /menu, живой человек — /handoff`
    );
  });

  /** Подтверждение входа в админку по коду с дашборда. */
  async function handleLogin(ctx: Context, codeRaw: string): Promise<void> {
    if (!ctx.from || !ctx.chat || ctx.chat.type !== 'private') return;
    const code = codeRaw.trim();
    if (!code) {
      await ctx.reply('Использование: /login КОД\nКод появляется на странице дашборда, когда вы нажимаете «Войти через Telegram».');
      return;
    }
    const user: TgUser = {
      id: ctx.from.id,
      name: `${ctx.from.first_name ?? ''} ${ctx.from.last_name ?? ''}`.trim() || null,
      username: ctx.from.username ?? null,
    };
    const result = auth.authorizeLogin(code, user);
    if (result === 'ok') {
      await ctx.reply('✅ Вход подтверждён!\nВернитесь на страницу дашборда — она откроется автоматически (сессия на 7 дней).');
      return;
    }
    if (result === 'no_rights') {
      await ctx.reply(
        '⛔ Этот код — для администраторов дашборда, вас в списке нет.\n' +
          `Ваш Telegram ID: ${ctx.from.id}\n` +
          'Заявка отправлена владельцу. Если доступ нужен — попросите его добавить ваш ID (дашборд → Администраторы).'
      );
      await transport
        .notifyOwner(
          '⛔ Попытка входа в админку без прав:\n' +
            `${user.name ?? 'без имени'}${user.username ? ` (@${user.username})` : ''} · ID ${user.id}\n` +
            'Разрешить: дашборд → Администраторы → Заявки на доступ.'
        )
        .catch(() => {});
      return;
    }
    await ctx.reply('🔓 Код не найден или истёк (живёт 10 минут).\nОткройте дашборд, нажмите «Войти через Telegram» и попробуйте снова.');
  }

  bot.command('login', async (ctx) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const code = text.replace(/^\/login(@\S+)?\s*/i, '');
    await handleLogin(ctx, code);
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      'Что я умею:\n' +
        '• рассказываю о себе: возможности, ограничения, цена\n' +
        '• объясняю настройку: .env, база данных, LLM-режим\n' +
        '• подсказываю по запуску и деплою (Docker, VPS)\n' +
        '• принимаю заявки на подключение агента и зову автора\n\n' +
        'Команды:\n' +
        '/menu — быстрое меню\n' +
        '/handoff — позвать живого человека\n\n' +
        'Просто напишите вопрос текстом 🙂'
    );
  });

  bot.command('menu', async (ctx) => {
    await ctx.reply('Выберите раздел:', keyboardMenu());
  });

  bot.command('handoff', async (ctx) => {
    const info = clientOf(ctx);
    if (!info) return;
    await pipeline.handleUserMessage(info, 'Позовите менеджера, пожалуйста');
  });

  // ---------- Инлайн-кнопки ----------

  bot.on('callback_query', async (ctx) => {
    await ctx.answerCbQuery();
    const info = clientOf(ctx);
    if (!info || !('data' in ctx.callbackQuery)) return;

    switch (ctx.callbackQuery.data) {
      case 'menu:capabilities':
        await pipeline.handleUserMessage(info, 'Что ты умеешь? Расскажи о своих возможностях');
        return;
      case 'menu:setup':
        await pipeline.handleUserMessage(info, 'Как настроить бота: переменные окружения, база данных, LLM');
        return;
      case 'menu:deploy':
        await pipeline.handleUserMessage(info, 'Как запустить и задеплоить бота на сервер');
        return;
      case 'menu:faq':
        await pipeline.handleUserMessage(info, 'Частые вопросы: ты человек, кто тебя сделал, куда деваются сообщения');
        return;
      case 'menu:lead':
        await pipeline.handleUserMessage(info, 'Хочу оставить заявку — подключить такого агента своему бизнесу');
        return;
      case 'menu:about':
        await pipeline.handleUserMessage(info, 'Расскажи о себе: кто ты и как устроен');
        return;
      case 'menu:handoff':
        await pipeline.handleUserMessage(info, 'Позовите менеджера, пожалуйста');
        return;
      default:
        return;
    }
  });

  // ---------- Обычные текстовые сообщения ----------

  bot.on('text', async (ctx) => {
    const info = clientOf(ctx);
    if (!info) return;
    try {
      await pipeline.handleUserMessage(info, ctx.message.text);
    } catch (err) {
      console.error('[bot] Ошибка обработки сообщения:', err);
      await ctx.reply('Что-то сломалось на нашей стороне 🙈 Попробуйте ещё раз чуть позже.').catch(() => {});
    }
  });

  // Telegraf 4: launch() может не резолвиться до остановки бота —
  // запускаем в фоне, чтобы не блокировать старт дашборда.
  void bot.launch().catch((err) => {
    console.error('[bot] Ошибка polling:', err instanceof Error ? err.message : err);
  });
  console.log(`[bot] Телеграм-бот запущен: @${me.username} (polling)`);

  return {
    sendTo: transport.send,
    notifyOwner: transport.notifyOwner,
    username: me.username ?? '',
    stop: async () => {
      await bot.stop('SIGTERM');
    },
  };
}

// ---------- утилиты ----------

function clientOf(ctx: Context): { chatId: string; name: string | null; username: string | null } | null {
  if (!ctx.chat || ctx.chat.type !== 'private' || !ctx.from) return null; // работаем только в личке
  return {
    chatId: String(ctx.chat.id),
    name: `${ctx.from.first_name ?? ''} ${ctx.from.last_name ?? ''}`.trim() || null,
    username: ctx.from.username ?? null,
  };
}

function keyboardMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🤖 Что я умею', 'menu:capabilities')],
    [Markup.button.callback('⚙️ Как настроить', 'menu:setup')],
    [Markup.button.callback('🚀 Запуск и деплой', 'menu:deploy')],
    [Markup.button.callback('❓ Частые вопросы', 'menu:faq')],
    [Markup.button.callback('👨‍💼 Позвать человека', 'menu:handoff')],
  ]);
}
