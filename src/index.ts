import { config, assertRuntimeEnv } from './config';
import { createStore } from './storage';
import { createPipeline } from './agent/pipeline';
import { createBot, type BotHandle } from './bot/bot';
import { startDashboard } from './dashboard/server';
import { AdminRegistry } from './auth/admins';
import { createAuth } from './auth/auth';
import { brainMode } from './agent/brain';

/**
 * Точка входа: хранилище -> реестр админов/авторизация -> бот (если есть токен) -> дашборд.
 * Бот и дашборд разделены: без BOT_TOKEN дашборд всё равно поднимется.
 */

async function main(): Promise<void> {
  assertRuntimeEnv();
  const store = await createStore();
  console.log('[app] Режим мозга: %s | Бизнес: %s', brainMode(), config.businessName);

  // Авторизация дашборда: владелец + назначенные им Telegram ID
  const registry = new AdminRegistry(config.dataDir);
  const auth = createAuth(registry);
  console.log('[auth] Админов в реестре: %d (владелец %s)', registry.list().length, registry.ownerId() || 'не задан');

  // Бот с ретраями: при старте воркспейса сеть может быть ещё не готова.
  const MAX_ATTEMPTS = 8;
  let bot: BotHandle | null = null;
  if (!config.botToken) {
    console.error('[app] BOT_TOKEN не задан — работаем без бота, только дашборд.');
  } else {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !bot; attempt++) {
      try {
        bot = await createBot(store, auth);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS) {
          console.warn('[app] Бот не запустился (попытка %d/%d): %s — повтор через 5с', attempt, MAX_ATTEMPTS, msg);
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } else {
          console.error(
            '[app] Бот не запущен после %d попыток: %s\nДашборд продолжит работать — файлы и заявки доступны локально.',
            MAX_ATTEMPTS,
            msg
          );
        }
      }
    }
  }

  const pipeline = bot
    ? createPipeline(store, {
        send: (chatId, text) => bot!.sendTo(chatId, text),
        notifyOwner: (text) => bot!.notifyOwner(text),
      })
    : null;

  startDashboard(store, bot, pipeline, auth, registry);

  const shutdown = async (signal: string) => {
    console.log('\n[app] Остановка (%s)…', signal);
    try {
      await bot?.stop();
      await store.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[app] Фатальная ошибка запуска:', err);
  process.exit(1);
});
