import * as crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AdminRegistry } from './admins';

/**
 * Авторизация дашборда через Telegram (этап «безопасность» из AGENTS.md):
 *
 *  1) UI дашборда создаёт код входа: POST /api/auth/request;
 *  2) администратор подтверждает его ботом — /login КОД или кнопкой
 *     «Войти через Telegram» (deep link /start login_КОД);
 *  3) бот проверяет Telegram ID по реестру админов (AdminRegistry) и
 *     подтверждает код; чужой ID получает отказ, владелец — заявку на доступ;
 *  4) UI опрашивает GET /api/auth/status/:код и получает Bearer-токен сессии.
 *
 * Сессии живут в памяти (7 дней со скользящим TTL). После рестарта сервиса
 * достаточно войти заново — критичных данных в сессии нет.
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
const LOGIN_TTL_MS = 10 * 60 * 1000; // код входа живёт 10 минут
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O/1/I

/** Пользователь Telegram, подтвердивший вход. */
export interface TgUser {
  id: number;
  name: string | null;
  username: string | null;
}

export interface AdminSession {
  token: string;
  telegramId: number;
  name: string | null;
  username: string | null;
  isOwner: boolean;
}

type LoginStatus = 'pending' | 'authorized' | 'expired' | 'unknown';

interface LoginRequest {
  code: string;
  status: 'pending' | 'authorized';
  token: string | null;
  user: TgUser | null;
  createdAt: number;
}

/** Express-Request с подложенной сессией админа. */
export interface AuthedRequest extends Request {
  admin?: AdminSession;
}

export function createAuth(registry: AdminRegistry) {
  const sessions = new Map<string, AdminSession & { lastSeen: number; createdAt: number }>();
  const logins = new Map<string, LoginRequest>();

  function newCode(): string {
    const bytes = crypto.randomBytes(8);
    let out = '';
    for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return out;
  }

  /** Новый код входа (вызывает UI). Заодно чистим просроченные заявки. */
  function createLoginRequest(): LoginRequest {
    const now = Date.now();
    for (const [code, req] of logins) {
      if (now - req.createdAt > LOGIN_TTL_MS) logins.delete(code);
    }
    if (logins.size > 50) {
      const oldest = logins.keys().next().value;
      if (oldest) logins.delete(oldest);
    }
    const req: LoginRequest = { code: newCode(), status: 'pending', token: null, user: null, createdAt: now };
    logins.set(req.code, req);
    return req;
  }

  /**
   * Бот вызывает после /login КОД или /start login_КОД.
   * ok — код подтверждён и сессия создана; no_rights — человека нет в списке
   * админов (заявка на доступ зафиксирована); bad_code — код не найден/истёк.
   */
  function authorizeLogin(codeRaw: string, user: TgUser): 'ok' | 'no_rights' | 'bad_code' {
    const code = codeRaw.trim().toUpperCase();
    const req = logins.get(code);
    if (!req || Date.now() - req.createdAt > LOGIN_TTL_MS || req.status !== 'pending') return 'bad_code';
    if (!registry.isAdmin(user.id)) {
      registry.addAccessRequest(user);
      return 'no_rights';
    }
    registry.markLogin(user.id, user);
    const token = createSession(user, registry.isOwner(user.id));
    req.status = 'authorized';
    req.token = token;
    req.user = user;
    return 'ok';
  }

  /** Статус кода для UI-поллинга. Токен отдаётся только после подтверждения ботом. */
  function statusOf(codeRaw: string): { status: LoginStatus; token: string | null; user: TgUser | null } {
    const code = codeRaw.trim().toUpperCase();
    const req = logins.get(code);
    if (!req) return { status: 'unknown', token: null, user: null };
    if (Date.now() - req.createdAt > LOGIN_TTL_MS) return { status: 'expired', token: null, user: null };
    return { status: req.status, token: req.token, user: req.user };
  }

  function createSession(user: TgUser, isOwner: boolean): string {
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    sessions.set(token, { token, telegramId: user.id, name: user.name, username: user.username, isOwner, createdAt: now, lastSeen: now });
    return token;
  }

  function tokenFrom(req: Request): string | null {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m ? m[1].trim() : null;
  }

  function getSession(token: string | null | undefined): AdminSession | null {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.lastSeen > SESSION_TTL_MS) {
      sessions.delete(token);
      return null;
    }
    // Админа убрали из списка (или он не владелец-владелец) — сессия умирает сразу
    if (!registry.isAdmin(s.telegramId)) {
      sessions.delete(token);
      return null;
    }
    s.lastSeen = Date.now(); // скользящий TTL
    const { lastSeen: _ls, createdAt: _c, ...rest } = s;
    return rest;
  }

  /** Express-мидлварь: пускает дальше только с валидной сессией. */
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const s = getSession(tokenFrom(req));
    if (!s) {
      res.status(401).json({ error: 'Требуется вход через Telegram' });
      return;
    }
    (req as AuthedRequest).admin = s;
    next();
  }

  /** Только для владельца (управление админами). */
  function requireOwner(req: Request, res: Response, next: NextFunction): void {
    const s = (req as AuthedRequest).admin;
    if (!s?.isOwner) {
      res.status(403).json({ error: 'Доступно только владельцу' });
      return;
    }
    next();
  }

  function logout(token: string | null | undefined): void {
    if (token) sessions.delete(token);
  }

  // Чистка протухших сессий раз в полчаса (не держим процесс живым)
  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const [token, s] of sessions) {
      if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(token);
    }
  }, 30 * 60 * 1000);
  cleaner.unref?.();

  return { createLoginRequest, authorizeLogin, statusOf, createSession, getSession, requireAuth, requireOwner, logout };
}

export type Auth = ReturnType<typeof createAuth>;
