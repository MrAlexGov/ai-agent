import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const rawDatabaseUrl = process.env.DATABASE_URL ?? '';
// Принимаем только Postgres-строки (чтобы случайные переменные вроде
// sqlite/file:// из окружения не ломали запуск).
const databaseUrl = /^(postgres(ql)?:\/\/)/i.test(rawDatabaseUrl) ? rawDatabaseUrl : '';
if (rawDatabaseUrl && !databaseUrl) {
  console.warn('[config] DATABASE_URL задан, но не является postgres:// строкой — игнорирую, использую JSON-хранилище');
}

/** Конфиг приложения. Все настройки — из .env (никаких секретов в коде). */
export const config = {
  botToken: process.env.BOT_TOKEN ?? '',
  ownerId: process.env.OWNER_TELEGRAM_ID ?? '',
  businessName: process.env.BUSINESS_NAME ?? 'ПримерКомпани',
  databaseUrl,
  llm: {
    apiKey: process.env.LLM_API_KEY ?? '',
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
  },
  // Мини-сервис по умолчанию живёт на 3030 (Next-прокси и AGENT_SERVICE_URL
  // ожидают именно его); 3000 в проде занят standalone-сервером Next.
  dashboardPort: Number(process.env.DASHBOARD_PORT ?? 3030),
  /** Дополнительные админы дашборда через запятую (владелец добавляется всегда). */
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),
  /**
   * Демо-вход в дашборд без Telegram — ТОЛЬКО для песочницы (бот не запущен,
   * токена нет, подтверждать вход некому). В .env.prod не задавать!
   */
  devLogin: process.env.DASHBOARD_DEV_LOGIN === '1',
  /** Путь к базе знаний и к локальному JSON-хранилищу */
  knowledgeDir: path.resolve(process.cwd(), 'knowledge'),
  dataDir: path.resolve(process.cwd(), 'data'),
};

/**
 * Проверка окружения. Отсутствие knowledge/ больше НЕ фатально (в прод-контейнере
 * сервис может стартовать без БЗ — бот тогда отвечает фолбэком), только предупреждение.
 */
export function assertRuntimeEnv(): void {
  if (!fs.existsSync(config.knowledgeDir)) {
    console.warn(
      '[config] Папка базы знаний не найдена: %s — бот будет отвечать без БЗ (фолбэк).',
      config.knowledgeDir
    );
  }
}
