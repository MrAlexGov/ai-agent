import { Pool } from 'pg';
import type {
  ChatMessage,
  ChatMode,
  MessageRole,
  NewTicket,
  Store,
  Ticket,
  TicketStatus,
} from './types';

/**
 * Postgres/Supabase-хранилище (как в видео — Supabase).
 * Включается автоматически, если в .env задан DATABASE_URL.
 * Таблицы создаёт сам при старте (см. sql/schema.sql — та же схема).
 */
export class PgStore implements Store {
  readonly backend = 'postgres' as const;
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5 });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY,
        name TEXT, username TEXT, phone TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages (chat_id, created_at);
      CREATE TABLE IF NOT EXISTS tickets (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'lead',
        status TEXT NOT NULL DEFAULT 'new',
        user_name TEXT, username TEXT, contact TEXT, topic TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status, created_at);
      CREATE TABLE IF NOT EXISTS chat_modes (
        chat_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'bot',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveMessage(m: { chatId: string; role: MessageRole; text: string }): Promise<void> {
    await this.pool.query(
      'INSERT INTO messages (chat_id, role, text) VALUES ($1, $2, $3)',
      [m.chatId, m.role, m.text]
    );
  }

  async getHistory(chatId: string, limit: number): Promise<ChatMessage[]> {
    const r = await this.pool.query(
      `SELECT chat_id, role, text, created_at FROM messages
       WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [chatId, limit]
    );
    return r.rows
      .map((row) => ({
        chatId: String(row.chat_id),
        role: row.role as MessageRole,
        text: String(row.text),
        createdAt: new Date(row.created_at).toISOString(),
      }))
      .reverse();
  }

  async getUser(chatId: string) {
    const r = await this.pool.query(
      'SELECT name, username, phone FROM users WHERE chat_id = $1',
      [chatId]
    );
    return r.rows[0] ?? null;
  }

  async upsertUser(u: {
    chatId: string;
    name?: string | null;
    username?: string | null;
    phone?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO users (chat_id, name, username, phone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_id) DO UPDATE SET
         name  = COALESCE(EXCLUDED.name, users.name),
         username = COALESCE(EXCLUDED.username, users.username),
         phone = COALESCE(EXCLUDED.phone, users.phone)`,
      [u.chatId, u.name ?? null, u.username ?? null, u.phone ?? null]
    );
  }

  async getChatMode(chatId: string): Promise<ChatMode> {
    const r = await this.pool.query('SELECT mode FROM chat_modes WHERE chat_id = $1', [chatId]);
    return (r.rows[0]?.mode as ChatMode) ?? 'bot';
  }

  async setChatMode(chatId: string, mode: ChatMode): Promise<void> {
    await this.pool.query(
      `INSERT INTO chat_modes (chat_id, mode) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
      [chatId, mode]
    );
  }

  async createTicket(t: NewTicket): Promise<Ticket> {
    const r = await this.pool.query(
      `INSERT INTO tickets (chat_id, kind, user_name, username, contact, topic)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [t.chatId, t.kind, t.userName ?? null, t.username ?? null, t.contact ?? null, t.topic ?? null]
    );
    const row = r.rows[0];
    return {
      id: Number(row.id),
      chatId: t.chatId,
      kind: t.kind,
      status: 'new',
      userName: t.userName ?? null,
      username: t.username ?? null,
      contact: t.contact ?? null,
      topic: t.topic ?? null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.created_at).toISOString(),
    };
  }

  async getTicket(id: number): Promise<Ticket | null> {
    const r = await this.pool.query('SELECT * FROM tickets WHERE id = $1', [id]);
    return r.rows[0] ? rowToTicket(r.rows[0]) : null;
  }

  async listTickets(status?: TicketStatus): Promise<Ticket[]> {
    const r = status
      ? await this.pool.query('SELECT * FROM tickets WHERE status = $1 ORDER BY created_at DESC', [status])
      : await this.pool.query('SELECT * FROM tickets ORDER BY created_at DESC');
    return r.rows.map(rowToTicket);
  }

  async updateTicket(id: number, patch: Partial<Pick<Ticket, 'status' | 'contact' | 'topic'>>): Promise<void> {
    await this.pool.query(
      `UPDATE tickets SET
         status = COALESCE($2, status),
         contact = COALESCE($3, contact),
         topic = COALESCE($4, topic),
         updated_at = now()
       WHERE id = $1`,
      [id, patch.status ?? null, patch.contact ?? null, patch.topic ?? null]
    );
  }
}

function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: Number(row.id),
    chatId: String(row.chat_id),
    kind: row.kind as Ticket['kind'],
    status: row.status as Ticket['status'],
    userName: (row.user_name as string) ?? null,
    username: (row.username as string) ?? null,
    contact: (row.contact as string) ?? null,
    topic: (row.topic as string) ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}
