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
  dashboardPort: Number(process.env.DASHBOARD_PORT ?? 3000),
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? '',
  /** Путь к базе знаний и к локальному JSON-хранилищу */
  knowledgeDir: path.resolve(process.cwd(), 'knowledge'),
  dataDir: path.resolve(process.cwd(), 'data'),
};

/** Проверка, что проект запускают из корня (рядом лежит knowledge/). */
export function assertRuntimeEnv(): void {
  if (!fs.existsSync(config.knowledgeDir)) {
    throw new Error(
      `Не найдена папка базы знаний: ${config.knowledgeDir}\n` +
        'Запускайте проект из корня репозитория (npm run dev).'
    );
  }
}
