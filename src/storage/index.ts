import { config } from '../config';
import { JsonStore } from './json-store';
import { PgStore } from './pg-store';
import type { Store } from './types';

/**
 * Фабрика хранилища:
 *  - задан DATABASE_URL  -> Postgres/Supabase (как в видео);
 *  - не задан            -> локальный JSON (работает из коробки).
 */
export async function createStore(): Promise<Store> {
  const store: Store = config.databaseUrl ? new PgStore(config.databaseUrl) : new JsonStore(config.dataDir);
  try {
    await store.init();
  } catch (err) {
    if (config.databaseUrl) {
      console.error(
        '[storage] Не удалось подключиться к Postgres/Supabase (%s).\n' +
          'Проверьте DATABASE_URL. Откатываюсь на локальный JSON-режим.\nДетали: %s',
        config.databaseUrl,
        err instanceof Error ? err.message : err
      );
      const fallback = new JsonStore(config.dataDir);
      await fallback.init();
      return fallback;
    }
    throw err;
  }
  console.log(`[storage] Бэкенд хранилища: ${store.backend}`);
  return store;
}
