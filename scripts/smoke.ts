import * as fs from 'fs';
import { config } from '../src/config';
import { JsonStore } from '../src/storage/json-store';
import { createPipeline } from '../src/agent/pipeline';
import type { ClientInfo } from '../src/agent/pipeline';

/**
 * npm run smoke — интеграционный прогон конвейера БЕЗ Telegram:
 * мок-транспорт + реальный JsonStore + реальная база знаний.
 * Проверяет: приветствие, поиск по БЗ, сбор заявки, эскалацию, режим human,
 * ответ менеджера и закрытие заявки.
 */

const client: ClientInfo = { chatId: '777', name: 'Тест Юзер', username: 'test_user' };

function fail(msg: string): never {
  console.error('  ❌ %s', msg);
  process.exitCode = 1;
  throw new Error(msg);
}

async function main(): Promise<void> {
  const dataDir = config.dataDir + '-smoke';
  fs.rmSync(dataDir, { recursive: true, force: true });
  const store = new JsonStore(dataDir);
  await store.init();

  const sent: Array<{ to: string; text: string }> = [];
  const notified: string[] = [];
  const pipeline = createPipeline(store, {
    send: async (to, text) => void sent.push({ to, text }),
    notifyOwner: async (text) => void notified.push(text),
  });

  const lastSent = () => sent[sent.length - 1]?.text ?? '';
  let ticketSeq = 0;

  // 1. Приветствие
  await pipeline.handleUserMessage(client, 'Привет!');
  if (!/ассистент/.test(lastSent())) fail('приветствие не сработало');
  console.log('  ✅ Приветствие: %s…', lastSent().slice(0, 40).replace(/\n/g, ' '));

  // 2. Вопрос по цене -> база знаний
  await pipeline.handleUserMessage(client, 'сколько стоит базовый тариф?');
  if (!/Стандартный|Базовый тариф|цен/i.test(lastSent())) fail('поиск по прайсу не сработал');
  console.log('  ✅ Вопрос по цене — ответ из knowledge/pricing.md');

  // 3. Незнакомый вопрос — честный фолбэк
  await pipeline.handleUserMessage(client, 'какая погода на Марсе?');
  if (!/не нашёл точный ответ/i.test(lastSent())) fail('фолбэк при отсутствии ответа не сработал');
  console.log('  ✅ Нет данных в БЗ — честный фолбэк с предложением меню');

  // 4. Лид -> запрос контакта
  await pipeline.handleUserMessage(client, 'хочу заказать консультацию');
  if (!/контакт/i.test(lastSent())) fail('лид-флоу не запросил контакт');
  console.log('  ✅ Лид распознан, бот запросил контакт');

  // 5. Контакт -> заявка + уведомление владельцу
  await pipeline.handleUserMessage(client, 'мой телефон +7 999 111-22-33');
  const leadTicket = await store.listTickets();
  if (leadTicket.length !== 1) fail('заявка не создалась');
  ticketSeq = leadTicket[0].id;
  if (leadTicket[0].contact !== '+79991112233') fail('контакт сохранился криво: ' + leadTicket[0].contact);
  if (notified.length !== 1) fail('уведомление владельцу не ушло');
  console.log('  ✅ Заявка #%d создана, владельцу отправлено уведомление', ticketSeq);

  // 6. Эскалация -> handoff + режим human (бот молчит)
  await pipeline.handleUserMessage(client, 'это обман, верните деньги, позовите менеджера!');
  const tickets = await store.listTickets();
  if (tickets.length !== 2 || tickets[0].kind !== 'handoff') fail('handoff-тикет не создался');
  const handoffId = tickets[0].id;
  if ((await store.getChatMode(client.chatId)) !== 'human') fail('режим human не включился');
  const before = sent.length;
  await pipeline.handleUserMessage(client, 'ну вы чего там?');
  if (sent.length !== before) fail('бот должен молчать в режиме human');
  console.log('  ✅ Эскалация: тикет handoff, бот молчит, владелец уведомлён');

  // 7. Ответ менеджера из дашборда -> клиенту
  await pipeline.ownerReply(ticketSeq, 'Здравствуйте! Разбираемся, всё вернём.');
  const history = await store.getHistory(client.chatId, 50);
  if (!history.some((m) => m.role === 'owner')) fail('ответ менеджера не сохранён в память');
  console.log('  ✅ Ответ менеджера ушёл клиенту и записан в диалог');

  // 8. Закрытие handoff-тика -> бот снова работает
  await pipeline.closeTicket(handoffId);
  if ((await store.getChatMode(client.chatId)) !== 'bot') fail('режим bot не вернулся после закрытия');
  console.log('  ✅ Заявка закрыта, бот снова в строю');

  // Уборка за собой
  await store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log('\n🏁 Смоук-тест пройден: конвейер работает end-to-end.\n');
  if (process.exitCode === 1) process.exit(1);
}

main().catch((e) => {
  console.error('Смоук-тест упал:', e);
  process.exit(1);
});
