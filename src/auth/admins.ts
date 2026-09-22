import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

/**
 * Реестр администраторов дашборда: владелец + назначенные им Telegram ID.
 *
 * Хранится в data/admins.json (рядом с db.json). При каждом старте список
 * ДОСЕВАЕТСЯ из env (OWNER_TELEGRAM_ID + ADMIN_TELEGRAM_IDS) — владельца и
 * env-админов нельзя выкинуть ни через дашборд, ни правкой файла.
 *
 * Назначать админов владельцу удобнее через дашборд (Администраторы): так
 * назначения живут до следующего деплоя контейнера. Для постоянного списка —
 * пропишите ID через запятую в ADMIN_TELEGRAM_IDS (.env.prod) и перезапустите.
 */

/** Запись администратора дашборда. */
export interface AdminRecord {
  telegramId: number;
  name: string | null;
  username: string | null;
  isOwner: boolean;
  addedAt: string;
  lastLogin: string | null;
}

/** Заявка на доступ: кто-то пытался войти, но его нет в списке админов. */
export interface AccessRequest {
  telegramId: number;
  name: string | null;
  username: string | null;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
}

interface AdminsFile {
  admins: AdminRecord[];
  requests: AccessRequest[];
}

export class AdminRegistry {
  private file: string;
  private data: AdminsFile;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'admins.json');
    this.data = { admins: [], requests: [] };
    this.load();
    this.seedFromEnv();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<AdminsFile>;
        this.data = {
          admins: Array.isArray(parsed.admins) ? parsed.admins : [],
          requests: Array.isArray(parsed.requests) ? parsed.requests : [],
        };
      }
    } catch (err) {
      console.warn('[auth] admins.json повреждён — начинаю с пустого реестра: %s', err instanceof Error ? err.message : err);
      this.data = { admins: [], requests: [] };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[auth] Не удалось записать admins.json: %s', err instanceof Error ? err.message : err);
    }
  }

  /** Идентификатор владельца из env (0 — не задан). */
  ownerId(): number {
    return Number(config.ownerId) || 0;
  }

  /** Досев владельца и env-админов при старте (уже добавленных не трогаем). */
  private seedFromEnv(): void {
    const owner = this.ownerId();
    const ids = new Set<number>(config.adminTelegramIds);
    if (owner > 0) ids.add(owner);
    for (const id of ids) {
      const rec = this.data.admins.find((a) => a.telegramId === id);
      if (!rec) {
        this.data.admins.push({
          telegramId: id,
          name: null,
          username: null,
          isOwner: id === owner,
          addedAt: new Date().toISOString(),
          lastLogin: null,
        });
      } else if (id === owner) {
        rec.isOwner = true; // владелец всегда остаётся владельцем
      }
    }
    this.save();
  }

  isAdmin(id: number): boolean {
    return this.data.admins.some((a) => a.telegramId === id);
  }

  isOwner(id: number): boolean {
    return id === this.ownerId();
  }

  list(): AdminRecord[] {
    return [...this.data.admins];
  }

  listRequests(): AccessRequest[] {
    return [...this.data.requests];
  }

  /** Добавить админа. false — некорректный ID или уже в списке. */
  addAdmin(telegramId: number, profile?: { name?: string | null; username?: string | null }): boolean {
    if (!Number.isInteger(telegramId) || telegramId <= 0) return false;
    if (this.isAdmin(telegramId)) return false;
    this.data.admins.push({
      telegramId,
      name: profile?.name ?? null,
      username: profile?.username ?? null,
      isOwner: false,
      addedAt: new Date().toISOString(),
      lastLogin: null,
    });
    for (const r of this.data.requests) {
      if (r.telegramId === telegramId && r.status === 'pending') r.status = 'approved';
    }
    this.save();
    return true;
  }

  removeAdmin(telegramId: number): 'ok' | 'owner' | 'not_found' {
    if (this.isOwner(telegramId)) return 'owner';
    const idx = this.data.admins.findIndex((a) => a.telegramId === telegramId);
    if (idx === -1) return 'not_found';
    this.data.admins.splice(idx, 1);
    this.save();
    return 'ok';
  }

  /** Неавторизованная попытка входа — заявка владельцу (одна строка на человека). */
  addAccessRequest(user: { id: number; name: string | null; username: string | null }): void {
    const now = new Date().toISOString();
    // Уже была заявка (любой статус) — оживляем её в pending, список не засоряем
    const existing = this.data.requests.find((r) => r.telegramId === user.id);
    if (existing) {
      existing.status = 'pending';
      existing.requestedAt = now;
      if (user.name) existing.name = user.name;
      if (user.username) existing.username = user.username;
      this.save();
      return;
    }
    this.data.requests.unshift({ telegramId: user.id, name: user.name, username: user.username, requestedAt: now, status: 'pending' });
    if (this.data.requests.length > 50) this.data.requests = this.data.requests.slice(0, 50);
    this.save();
  }

  /** Решение владельца по заявке. При одобрении админ сразу добавляется. */
  resolveRequest(telegramId: number, approve: boolean): boolean {
    const rec = this.data.requests.find((r) => r.telegramId === telegramId && r.status === 'pending');
    if (!rec) return false;
    rec.status = approve ? 'approved' : 'rejected';
    if (approve) this.addAdmin(telegramId, rec);
    this.save();
    return true;
  }

  /** Обновляем профиль и время последнего входа после успешного логина. */
  markLogin(telegramId: number, user: { name: string | null; username: string | null }): void {
    const rec = this.data.admins.find((a) => a.telegramId === telegramId);
    if (!rec) return;
    if (user.name) rec.name = user.name;
    if (user.username) rec.username = user.username;
    rec.lastLogin = new Date().toISOString();
    this.save();
  }
}
