import { config, assertRuntimeEnv } from '../src/config';
import { searchKb, kbStats } from '../src/kb/search';
import { detectIntent, extractContact } from '../src/agent/intents';
import { brainMode } from '../src/agent/brain';
import { PgStore } from '../src/storage/pg-store';

/**
 * npm run doctor — самопроверка окружения:
 * токен, БД, база знаний, движок интентов. Никого не пугает, только диагностирует.
 */

const ok = (s: string) => console.log('  ✅ %s', s);
const warn = (s: string) => console.log('  ⚠️  %s', s);
const bad = (s: string) => console.log('  ❌ %s', s);

async function main(): Promise<void> {
  console.log('\n🔍 AI-агент: диагностика окружения\n');

  // 1. База знаний
  try {
    assertRuntimeEnv();
    const stats = kbStats();
    ok(`База знаний: ${stats.files} файла(ов), ${stats.chunks} фрагментов в knowledge/`);
    const hits = searchKb('сколько стоит консультация', 2);
    ok(
      hits.length > 0
        ? `Поиск по БЗ работает, топ-хит: «${hits[0].heading}» (${hits[0].source})`
        : 'Поиск по БЗ вернул пусто на тестовом запросе'
    );
  } catch (e) {
    bad(`База знаний: ${e instanceof Error ? e.message : e}`);
  }

  // 2. Токен бота
  if (config.botToken && config.botToken.includes(':')) ok('BOT_TOKEN задан');
  else bad('BOT_TOKEN не задан или кривой — скопируйте .env.example в .env');

  // 3. Владелец
  if (/^\d+$/.test(config.ownerId)) ok(`OWNER_TELEGRAM_ID задан (${config.ownerId})`);
  else warn('OWNER_TELEGRAM_ID не задан — уведомления о заявках не будут уходить');

  // 4. Хранилище
  if (!config.databaseUrl) {
    warn('DATABASE_URL не задан — использую локальный JSON (data/db.json). Это нормально для старта');
  } else {
    const pg = new PgStore(config.databaseUrl);
    try {
      await pg.init();
      await pg.close();
      ok('Postgres/Supabase: подключение и таблицы в порядке');
    } catch (e) {
      const detail = e instanceof Error ? `${e.message} ${JSON.stringify((e as NodeJS.ErrnoException & { code?: string }).code ?? '')}` : String(e);
      bad(`Postgres/Supabase: подключение не удалось (${detail.trim()})`);
    }
  }

  // 5. Мозг
  console.log(`  ${config.llm.apiKey ? '✅' : '⚠️ '} Мозг: ${brainMode()}${config.llm.apiKey ? '' : ' (LLM_API_KEY не задан — отвечаю по правилам и БЗ)'}`);

  // 6. Движок интентов: мини-тесты
  const cases: Array<[string, string, boolean]> = [
    ['сколько стоит тариф', 'pricing', false],
    ['позовите менеджера!!!', 'escalation', false],
    ['хочу оставить заявку', 'lead', false],
    ['привет', 'greeting', false],
    ['мой телефон +7 999 123-45-67', 'faq', true],
  ];
  let pass = 0;
  for (const [text, expected, isContact] of cases) {
    const got = detectIntent(text);
    const contact = extractContact(text) !== null;
    if (got === expected && contact === isContact) pass++;
    else bad(`Интент-тест: «${text}» -> ${got}${contact ? '+контакт' : ''} (ожидалось ${expected}${isContact ? '+контакт' : ''})`);
  }
  if (pass === cases.length) ok(`Интент-тесты: ${pass}/${cases.length} пройдено`);

  console.log('\n🏁 Диагностика завершена. Запуск: npm run dev\n');
}

main().catch((e) => {
  console.error('Фатальная ошибка doctor:', e);
  process.exit(1);
});
