-- ============================================================
-- Схема БД для AI-агента (Postgres / Supabase)
-- Применять вручную не обязательно: pg-store создаёт таблицы
-- сам при первом старте (CREATE TABLE IF NOT EXISTS).
-- Файл нужен для ревью/миграций и для Supabase SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  chat_id    TEXT PRIMARY KEY,            -- Telegram chat id (строкой для совместимости)
  name       TEXT,
  username   TEXT,
  phone      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  role       TEXT NOT NULL,               -- 'user' | 'bot' | 'owner'
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);

CREATE TABLE IF NOT EXISTS tickets (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'lead',      -- 'lead' | 'handoff'
  status     TEXT NOT NULL DEFAULT 'new',       -- 'new' | 'in_progress' | 'done'
  user_name  TEXT,
  username   TEXT,
  contact    TEXT,
  topic      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status, created_at);

-- Режим чата: 'bot' | 'contact' (ждём контакт) | 'human' (идёт живой диалог)
CREATE TABLE IF NOT EXISTS chat_modes (
  chat_id    TEXT PRIMARY KEY,
  mode       TEXT NOT NULL DEFAULT 'bot',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
