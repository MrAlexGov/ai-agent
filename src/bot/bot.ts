import { Telegraf, Markup, Context } from 'telegraf';
import type { Store } from '../storage/types';
import { createPipeline } from '../agent/pipeline';
import { config } from '../config';

/**
 * Telegram-слой (этап 1): команды, инлайн-меню, приём сообщений,
 * уведомления владельцу. Бизнес-логика — в pipeline, здесь только транспорт.
 */

export interface BotHandle {
  /** Отправка произвольного сообщения клиенту (для дашборда). */
  sendTo(chatId: string, text: string): Promise<void>;
  /** Уведомление владельцу в личку. */
  notifyOwner(text: string): Promise<void>;
  stop(): Promise<void>;
}

export async function createBot(store: Store): Promise<BotHandle> {
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
    const info = clientOf(ctx);
    if (!info) return;
    await ctx.reply(
      `Здравствуйте! 👋 Я AI-ассистент «${config.businessName}».\n` +
        'Отвечу на вопросы о компании, ценах и услугах, помогу оставить заявку.\n\n' +
        'Меню — /menu, живой менеджер — /handoff'
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      'Что я умею:\n' +
        '• отвечаю на вопросы по базе знаний компании\n' +
        '• принимаю заявки и передаю менеджеру\n\n' +
        'Команды:\n' +
        '/menu — быстрое меню\n' +
        '/handoff — позвать живого менеджера\n\n' +
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
      case 'menu:pricing':
        await pipeline.handleUserMessage(info, 'Покажите цены и тарифы');
        return;
      case 'menu:faq':
        await pipeline.handleUserMessage(info, 'Частые вопросы: как с вами связаться, график работы');
        return;
      case 'menu:lead':
        await pipeline.handleUserMessage(info, 'Хочу оставить заявку на консультацию');
        return;
      case 'menu:about':
        await pipeline.handleUserMessage(info, 'Расскажите о компании');
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
    [Markup.button.callback('💰 Цены и тарифы', 'menu:pricing')],
    [Markup.button.callback('❓ Частые вопросы', 'menu:faq')],
    [Markup.button.callback('🏢 О компании', 'menu:about')],
    [Markup.button.callback('📝 Оставить заявку', 'menu:lead')],
    [Markup.button.callback('👨‍💼 Позвать менеджера', 'menu:handoff')],
  ]);
}
