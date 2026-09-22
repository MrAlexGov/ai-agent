/** Общий контракт хранилища. Две реализации: json-store (по умолчанию) и pg-store. */

export type ChatMode = 'bot' | 'contact' | 'human';
export type MessageRole = 'user' | 'bot' | 'owner';
export type TicketKind = 'lead' | 'handoff';
export type TicketStatus = 'new' | 'in_progress' | 'done';

export interface ChatMessage {
  chatId: string;
  role: MessageRole;
  text: string;
  createdAt: string;
}

export interface Ticket {
  id: number;
  chatId: string;
  kind: TicketKind;
  status: TicketStatus;
  userName: string | null;
  username: string | null;
  contact: string | null;
  topic: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTicket {
  chatId: string;
  kind: TicketKind;
  userName?: string | null;
  username?: string | null;
  contact?: string | null;
  topic?: string | null;
}

export interface Store {
  readonly backend: 'json' | 'postgres';
  init(): Promise<void>;
  close(): Promise<void>;

  saveMessage(m: { chatId: string; role: MessageRole; text: string }): Promise<void>;
  getHistory(chatId: string, limit: number): Promise<ChatMessage[]>;

  getUser(chatId: string): Promise<{ name: string | null; username: string | null; phone: string | null } | null>;
  upsertUser(u: { chatId: string; name?: string | null; username?: string | null; phone?: string | null }): Promise<void>;

  getChatMode(chatId: string): Promise<ChatMode>;
  setChatMode(chatId: string, mode: ChatMode): Promise<void>;

  createTicket(t: NewTicket): Promise<Ticket>;
  getTicket(id: number): Promise<Ticket | null>;
  listTickets(status?: TicketStatus): Promise<Ticket[]>;
  updateTicket(id: number, patch: Partial<Pick<Ticket, 'status' | 'contact' | 'topic'>>): Promise<void>;
}
