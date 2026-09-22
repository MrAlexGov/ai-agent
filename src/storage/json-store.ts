import * as fs from 'fs';
import * as path from 'path';
import type {
  ChatMessage,
  ChatMode,
  MessageRole,
  Store,
  Ticket,
  TicketStatus,
  NewTicket,
} from './types';

/**
 * JSON-хранилище: ноль настройки, всё в data/db.json.
 * Для MVP и локальных демо; при росте нагрузки — переключиться на pg-store
 * (просто задать DATABASE_URL, контракт Store одинаковый).
 */
interface DbShape {
  users: Record<string, { name: string | null; username: string | null; phone: string | null }>;
  messages: ChatMessage[];
  tickets: Ticket[];
  modes: Record<string, ChatMode>;
  seq: number;
}

export class JsonStore implements Store {
  readonly backend = 'json' as const;
  private file = '';
  private db!: DbShape;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'db.json');
  }

  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        this.db = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      } catch {
        console.warn('[storage] db.json повреждён — начинаю с чистого файла');
        this.db = emptyDb();
      }
    } else {
      this.db = emptyDb();
    }
    this.flush();
  }

  async close(): Promise<void> {
    this.flush();
  }

  async saveMessage(m: { chatId: string; role: MessageRole; text: string }): Promise<void> {
    this.db.messages.push({ ...m, createdAt: new Date().toISOString() });
    // Держим историю управляемой: последние 500 сообщений на чат не храним бесконечно
    if (this.db.messages.length > 5000) this.db.messages = this.db.messages.slice(-4000);
    this.flush();
  }

  async getHistory(chatId: string, limit: number): Promise<ChatMessage[]> {
    const rows = this.db.messages.filter((m) => m.chatId === chatId);
    return rows.slice(-limit);
  }

  async getUser(chatId: string) {
    return this.db.users[chatId] ?? null;
  }

  async upsertUser(u: {
    chatId: string;
    name?: string | null;
    username?: string | null;
    phone?: string | null;
  }): Promise<void> {
    const cur = this.db.users[u.chatId] ?? { name: null, username: null, phone: null };
    this.db.users[u.chatId] = {
      name: u.name ?? cur.name,
      username: u.username ?? cur.username,
      phone: u.phone ?? cur.phone,
    };
    this.flush();
  }

  async getChatMode(chatId: string): Promise<ChatMode> {
    return this.db.modes[chatId] ?? 'bot';
  }

  async setChatMode(chatId: string, mode: ChatMode): Promise<void> {
    this.db.modes[chatId] = mode;
    this.flush();
  }

  async createTicket(t: NewTicket): Promise<Ticket> {
    const id = ++this.db.seq;
    const now = new Date().toISOString();
    const ticket: Ticket = {
      id,
      chatId: t.chatId,
      kind: t.kind,
      status: 'new',
      userName: t.userName ?? null,
      username: t.username ?? null,
      contact: t.contact ?? null,
      topic: t.topic ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.tickets.push(ticket);
    this.flush();
    return ticket;
  }

  async getTicket(id: number): Promise<Ticket | null> {
    return this.db.tickets.find((t) => t.id === id) ?? null;
  }

  async listTickets(status?: TicketStatus): Promise<Ticket[]> {
    const rows = status ? this.db.tickets.filter((t) => t.status === status) : this.db.tickets;
    return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateTicket(id: number, patch: Partial<Pick<Ticket, 'status' | 'contact' | 'topic'>>): Promise<void> {
    const t = this.db.tickets.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    this.flush();
  }

  /** Запись на диск после каждой мутации: файл маленький, надёжность важнее скорости. */
  private flush(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.db, null, 2), 'utf-8');
  }
}

function emptyDb(): DbShape {
  return { users: {}, messages: [], tickets: [], modes: {}, seq: 0 };
}
