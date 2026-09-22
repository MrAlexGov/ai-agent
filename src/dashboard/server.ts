import express from 'express';
import type { Store, TicketStatus } from '../storage/types';
import type { BotHandle } from '../bot/bot';
import type { Pipeline } from '../agent/pipeline';
import type { Auth, AuthedRequest } from '../auth/auth';
import type { AdminRegistry } from '../auth/admins';
import { config } from '../config';

/**
 * API мини-сервиса (этап 7): заявки, диалоги, ответ клиенту, закрытие заявки.
 *
 * Авторизация: вход через Telegram (см. src/auth). Публичны только
 * /api/health и /api/auth/* — всё остальное требует Bearer-сессию админа,
 * управление списком админов — только владелец.
 */
export function startDashboard(
  store: Store,
  bot: BotHandle | null,
  pipeline: Pipeline | null,
  auth: Auth,
  registry: AdminRegistry
): void {
  const app = express();
  app.use(express.json());

  // API всегда отдаёт свежие данные (без HTTP-кэширования)
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ---------- Публичные роуты (без сессии) ----------

  /** Служебный статус: живость сервиса и режимы (для healthcheck и UI). */
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      botRunning: bot !== null,
      backend: store.backend,
      business: config.businessName,
      time: new Date().toISOString(),
    });
  });

  /** Шаг 1 входа: дашборд просит код подтверждения. */
  app.post('/api/auth/request', (_req, res) => {
    const lr = auth.createLoginRequest();
    res.json({
      requestId: lr.code,
      botUsername: bot?.username ?? '',
      botRunning: bot !== null,
      devMode: config.devLogin,
      expiresIn: 600,
    });
  });

  /** Шаг 3 входа: UI опрашивает статус кода, после подтверждения ботом получает токен. */
  app.get('/api/auth/status/:code', (req, res) => {
    res.json(auth.statusOf(String(req.params.code ?? '')));
  });

  // Демо-вход для песочницы: бота нет, подтверждать вход некому.
  // В .env.prod НЕ задавать — в проде вход только через Telegram.
  if (config.devLogin) {
    console.warn('[dashboard] DASHBOARD_DEV_LOGIN=1 — доступен демо-вход без Telegram (только для песочницы!)');
    app.post('/api/auth/dev-session', (_req, res) => {
      const owner = registry.ownerId();
      if (!owner) return res.status(500).json({ error: 'OWNER_TELEGRAM_ID не задан' });
      const token = auth.createSession({ id: owner, name: 'Dev-вход', username: null }, true);
      res.json({ token });
    });
    // Имитация подтверждения ботом (для локальных e2e-тестов): проверяет права так же строго.
    app.post('/api/auth/dev-authorize', (req, res) => {
      const code = String(req.body?.code ?? '');
      const tgId = Number(req.body?.telegramId ?? 0) || registry.ownerId();
      res.json({ result: auth.authorizeLogin(code, { id: tgId, name: 'Dev-тест', username: null }) });
    });
  }

  // ---------- Всё API ниже — только с сессией администратора ----------
  app.use('/api', auth.requireAuth);

  app.get('/api/auth/me', (req, res) => {
    const s = (req as AuthedRequest).admin!;
    res.json({ telegramId: s.telegramId, name: s.name, username: s.username, isOwner: s.isOwner });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.logout(req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? null);
    res.json({ ok: true });
  });

  // ---------- Управление администраторами (только владелец) ----------

  app.get('/api/admins', auth.requireOwner, (_req, res) => {
    res.json({ admins: registry.list(), requests: registry.listRequests() });
  });

  app.post('/api/admins', auth.requireOwner, (req, res) => {
    const id = Number(req.body?.telegramId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Нужен числовой Telegram ID' });
    const ok = registry.addAdmin(id);
    if (!ok) return res.status(400).json({ error: 'Админ с таким ID уже есть в списке' });
    res.json({ ok: true });
  });

  app.delete('/api/admins/:id', auth.requireOwner, (req, res) => {
    const r = registry.removeAdmin(Number(req.params.id));
    if (r === 'owner') return res.status(400).json({ error: 'Владельца нельзя убрать из списка' });
    if (r === 'not_found') return res.status(404).json({ error: 'Админ не найден' });
    res.json({ ok: true });
  });

  app.post('/api/admins/requests/:id/resolve', auth.requireOwner, (req, res) => {
    const approve = Boolean(req.body?.approve);
    const ok = registry.resolveRequest(Number(req.params.id), approve);
    if (!ok) return res.status(404).json({ error: 'Заявка не найдена (возможно, уже обработана)' });
    res.json({ ok: true });
  });

  // ---------- Заявки и диалоги ----------

  app.get('/api/tickets', async (req, res) => {
    try {
      const status = validStatus(req.query.status);
      const tickets = await store.listTickets(status);
      res.json(tickets);
    } catch (err) {
      res.status(500).json({ error: msg(err) });
    }
  });

  app.get('/api/tickets/:id/dialog', async (req, res) => {
    try {
      const ticket = await store.getTicket(Number(req.params.id));
      if (!ticket) return res.status(404).json({ error: 'Заявка не найдена' });
      const dialog = await store.getHistory(ticket.chatId, 40);
      res.json({ ticket, dialog });
    } catch (err) {
      res.status(500).json({ error: msg(err) });
    }
  });

  app.post('/api/tickets/:id/reply', async (req, res) => {
    try {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'Пустой текст' });
      if (!bot || !pipeline) return res.status(503).json({ error: 'Бот не запущен (нет BOT_TOKEN)' });
      await pipeline.ownerReply(Number(req.params.id), text.slice(0, 3500));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: msg(err) });
    }
  });

  app.post('/api/tickets/:id/close', async (req, res) => {
    try {
      if (!bot || !pipeline) return res.status(503).json({ error: 'Бот не запущен (нет BOT_TOKEN)' });
      await pipeline.closeTicket(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: msg(err) });
    }
  });

  // Запасная HTML-страница для автономного запуска (VPS без Next): тот же вход через Telegram.
  app.get('/', (_req, res) => res.type('html').send(page()));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  app.listen(config.dashboardPort, () => {
    console.log(`[dashboard] Дашборд владельца: http://localhost:${config.dashboardPort}`);
  });
}

// ---------- утилиты ----------

function validStatus(s: unknown): TicketStatus | undefined {
  return s === 'new' || s === 'in_progress' || s === 'done' ? s : undefined;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Одностраничный интерфейс дашборда (тёмная тема; список — 10 с, открытые диалоги — 2,5 с). */
function page(): string {
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Дашборд владельца</title>
<style>
  :root { --bg:#0f1420; --card:#171e2e; --line:#232c42; --text:#e8ecf5; --dim:#8b95ad; --acc:#5b9dff; --new:#ff7a6b; --ok:#4fd08a; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:15px/1.5 system-ui,'Segoe UI',Roboto,sans-serif; padding:24px; max-width:960px; margin:0 auto; }
  h1 { font-size:20px; margin-bottom:4px; }
  .sub { color:var(--dim); font-size:13px; margin-bottom:20px; }
  .filters { display:flex; gap:8px; margin-bottom:16px; }
  .filters button { background:var(--card); color:var(--dim); border:1px solid var(--line); padding:6px 14px; border-radius:20px; cursor:pointer; font-size:13px; }
  .filters button.on { color:var(--text); border-color:var(--acc); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:12px; }
  .row { display:flex; justify-content:space-between; gap:12px; align-items:baseline; flex-wrap:wrap; }
  .id { color:var(--acc); font-weight:600; }
  .kind { font-size:12px; color:var(--dim); }
  .status { font-size:12px; padding:2px 10px; border-radius:12px; border:1px solid var(--line); }
  .status.new { color:var(--new); border-color:var(--new); }
  .status.in_progress { color:var(--acc); border-color:var(--acc); }
  .status.done { color:var(--ok); border-color:var(--ok); }
  .meta { color:var(--dim); font-size:13px; margin-top:4px; }
  .topic { margin-top:8px; }
  .btn { background:transparent; color:var(--acc); border:1px solid var(--acc); border-radius:8px; padding:6px 14px; cursor:pointer; font-size:13px; }
  .btn.close { color:var(--ok); border-color:var(--ok); }
  .dialog { display:none; margin-top:12px; border-top:1px solid var(--line); padding-top:10px; }
  .msg { margin:6px 0; padding:8px 12px; border-radius:10px; max-width:85%; font-size:14px; white-space:pre-wrap; }
  .msg.user { background:#232c42; }
  .msg.bot { background:transparent; border:1px dashed var(--line); margin-left:auto; color:var(--dim); }
  .msg.owner { background:#2b3a5c; margin-left:auto; }
  .replybox { display:none; margin-top:10px; gap:8px; }
  .replybox textarea { flex:1; background:#0f1420; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px; min-height:60px; font:inherit; resize:vertical; }
  .empty { color:var(--dim); text-align:center; padding:40px 0; }
</style>
</head><body>
<h1>🧾 Заявки — владелец</h1>
<div class="sub">Новые заявки и эскалации. Ответ уходит клиенту в Telegram. Список — каждые 10 с, открытые диалоги — каждые 2,5 с.</div>
<div class="filters" id="filters">
  <button data-s="" class="on">Все</button>
  <button data-s="new">Новые</button>
  <button data-s="in_progress">В работе</button>
  <button data-s="done">Закрытые</button>
</div>
<div id="list"><div class="empty">Загрузка…</div></div>

<script>
let filter = '';
const $list = document.getElementById('list');
const TOKEN_KEY = 'agent_admin_token';
const openIds = {};   // id -> true: диалоги, раскрытые менеджером
const drafts = {};    // id -> набранный (но не отправленный) текст ответа
const lastCount = {}; // id -> число сообщений при прошлой отрисовке
function tok() { return localStorage.getItem(TOKEN_KEY) || ''; }
function authHeaders(extra) { return Object.assign({}, extra || {}, tok() ? { Authorization: 'Bearer ' + tok() } : {}); }
document.getElementById('filters').onclick = (e) => {
  if (e.target.dataset.s === undefined) return;
  filter = e.target.dataset.s;
  document.querySelectorAll('.filters button').forEach(b => b.classList.toggle('on', b === e.target));
  load();
};
async function api(path, opts) {
  const r = await fetch(path, Object.assign({}, opts || {}, { headers: authHeaders(opts && opts.headers) }));
  const j = await r.json();
  if (r.status === 401) { showLogin(); throw new Error('Требуется вход через Telegram'); }
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
function esc(s) { return (s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function roleLabel(r) { return {user:'👤 клиент', bot:'🤖 бот', owner:'👩‍💼 менеджер'}[r] || r; }

/** Окно входа: код подтверждается ботом в Telegram (как в Next-дашборде). */
function showLogin() {
  let box = document.getElementById('login');
  if (box) { box.style.display = 'flex'; return; }
  box = document.createElement('div');
  box.id = 'login';
  box.style.cssText = 'position:fixed;inset:0;background:rgba(5,8,15,.94);display:flex;align-items:center;justify-content:center;z-index:99';
  box.innerHTML = '<div style="background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px;max-width:400px;text-align:center;font-size:14px">' +
    '<h2 style="font-size:17px;margin-bottom:8px">🔐 Вход в админку</h2>' +
    '<p style="color:var(--dim);margin-bottom:14px">Доступ только для администраторов. Нажмите кнопку — откроется Telegram, там нужно отправить боту код подтверждения.</p>' +
    '<button id="loginBtn" class="btn" style="width:100%;padding:10px">Войти через Telegram</button>' +
    '<div id="loginState" style="margin-top:12px;color:var(--dim)"></div></div>';
  document.body.appendChild(box);
  document.getElementById('loginBtn').onclick = async () => {
    const state = document.getElementById('loginState');
    try {
      const req = await api('/api/auth/request', { method: 'POST' });
      if (req.devMode) {
        const s = await api('/api/auth/dev-session', { method: 'POST' });
        localStorage.setItem(TOKEN_KEY, s.token);
        location.reload();
        return;
      }
      if (!req.botUsername) { state.textContent = 'Бот не запущен — вход через Telegram недоступен'; return; }
      state.innerHTML = 'Код: <b style="color:var(--text)">' + req.requestId + '</b> · открываю Telegram…';
      window.open('https://t.me/' + req.botUsername + '?start=login_' + req.requestId, '_blank');
      const t = setInterval(async () => {
        try {
          const st = await api('/api/auth/status/' + req.requestId);
          if (st.status === 'authorized' && st.token) {
            clearInterval(t);
            localStorage.setItem(TOKEN_KEY, st.token);
            location.reload();
          } else if (st.status === 'expired' || st.status === 'unknown') {
            clearInterval(t);
            state.textContent = 'Код истёк — нажмите кнопку ещё раз';
          }
        } catch (e) { /* игнорируем сетевые блики, статус-поллинг продолжится */ }
      }, 2000);
    } catch (e) { state.textContent = 'Ошибка: ' + e.message; }
  };
}

/** Отрисовка диалога внутри карточки: сообщения + поле ответа (черновик сохраняется). */
function renderDialog(id, data) {
  const box = document.getElementById('d' + id);
  if (!box) return;
  const open = data.ticket.status !== 'done';
  if (open) openIds[id] = true; else delete openIds[id];
  lastCount[id] = data.dialog.length;
  box.innerHTML =
    '<div id="dlg' + id + '">' +
      data.dialog.map(m =>
        '<div class="msg ' + m.role + '"><b>' + roleLabel(m.role) + ':</b> ' + esc(m.text) + '</div>').join('') +
    '</div>' +
    (open
      ? '<div class="replybox" style="display:flex;margin-top:10px">' +
          '<textarea id="t' + id + '" data-id="' + id + '" placeholder="Ответ клиенту — уйдёт в Telegram от менеджера…" oninput="drafts[this.dataset.id]=this.value">' + esc(drafts[id] || '') + '</textarea></div>' +
        '<div style="text-align:right;margin-top:6px"><button class="btn" onclick="reply(' + id + ')">Отправить ➤</button></div>'
      : '<div class="meta" style="margin-top:8px">Заявка закрыта — поле ответа скрыто.</div>');
  box.style.display = 'block';
  const tg = document.getElementById('tg' + id);
  if (tg) tg.textContent = open ? '▲ Свернуть' : '💬 Диалог';
}

/** Живое обновление ОТКРЫТОГО диалога: заменяются только сообщения, поле ответа не трогается. */
async function refreshDialog(id) {
  if (!openIds[id]) return;
  if (!document.getElementById('dlg' + id)) return;
  const data = await api('/api/tickets/' + id + '/dialog');
  if (data.ticket.status === 'done') { renderDialog(id, data); return; } // скроет поле ответа
  const wrap = document.getElementById('dlg' + id);
  if (!wrap) return;
  const prev = lastCount[id] || 0;
  wrap.innerHTML = data.dialog.map(m =>
    '<div class="msg ' + m.role + '"><b>' + roleLabel(m.role) + ':</b> ' + esc(m.text) + '</div>').join('');
  lastCount[id] = data.dialog.length;
  if (data.dialog.length > prev && wrap.lastElementChild) {
    wrap.lastElementChild.scrollIntoView({ block: 'nearest' }); // новое сообщение — мягкий доскролл
  }
}

/** После фоновой перерисовки списка восстановить раскрытые диалоги (и черновики в них). */
async function reopenAll() {
  for (const key of Object.keys(openIds)) {
    if (!document.getElementById('d' + key)) { delete openIds[key]; continue; }
    try { renderDialog(Number(key), await api('/api/tickets/' + key + '/dialog')); } catch (e) { /* тихо, повторится */ }
  }
}

async function load() {
  try {
    const tickets = await api('/api/tickets' + (filter ? '?status=' + filter : ''));
    if (!tickets.length) {
      Object.keys(openIds).forEach(k => delete openIds[k]);
      $list.innerHTML = '<div class="empty">Заявок пока нет 🎉</div>';
      return;
    }
    $list.innerHTML = tickets.map(t =>
      '<div class="card" id="c' + t.id + '">' +
        '<div class="row"><span class="id">#' + t.id + ' ' + (t.kind === 'handoff' ? '🚨 эскалация' : '🧾 заявка') + '</span>' +
        '<span class="status ' + t.status + '">' + ({new:'новая', in_progress:'в работе', done:'закрыта'}[t.status]) + '</span></div>' +
        '<div class="meta">' + esc(t.userName || 'без имени') + (t.username ? ' · @' + esc(t.username) : '') + (t.contact ? ' · 📞 ' + esc(t.contact) : '') + ' · ' + new Date(t.createdAt).toLocaleString('ru-RU') + '</div>' +
        '<div class="topic">' + esc(t.topic || '') + '</div>' +
        '<div class="row" style="margin-top:10px">' +
          '<button class="btn" id="tg' + t.id + '" onclick="toggle(' + t.id + ', this)">💬 Диалог</button>' +
          (t.status !== 'done' ? '<button class="btn close" onclick="closeTicket(' + t.id + ')">✔ Закрыть</button>' : '') +
        '</div>' +
        '<div class="dialog" id="d' + t.id + '"></div>' +
      '</div>').join('');
    reopenAll(); // раскрытые диалоги и набранный текст переживают обновление списка
  } catch (e) {
    if (String(e.message).includes('вход через Telegram')) return; // показано окно входа
    $list.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>';
  }
}

async function toggle(id, btn) {
  const box = document.getElementById('d' + id);
  if (!box) return;
  if (box.style.display === 'block') {
    box.style.display = 'none';
    delete openIds[id];
    btn.textContent = '💬 Диалог';
    return;
  }
  renderDialog(id, await api('/api/tickets/' + id + '/dialog'));
}

async function reply(id) {
  const ta = document.getElementById('t' + id);
  const text = (ta.value || '').trim();
  if (!text) return alert('Введите текст');
  try {
    await api('/api/tickets/' + id + '/reply', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
    drafts[id] = '';
    ta.value = '';
    await refreshDialog(id);
    setTimeout(load, 500);
  } catch (e) { alert('Ошибка: ' + e.message); }
}

async function closeTicket(id) {
  if (!confirm('Закрыть заявку #' + id + '? Бот вернётся в чат.')) return;
  try { await api('/api/tickets/' + id + '/close', { method:'POST' }); load(); }
  catch (e) { alert('Ошибка: ' + e.message); }
}

// Старт: нет сессии — сразу окно входа; есть — проверяем и грузим данные
(async () => {
  if (!tok()) { showLogin(); return; }
  try { await api('/api/auth/me'); load(); } catch (e) { /* окно входа уже показано при 401 */ }
})();
setInterval(() => { if (tok()) load(); }, 10000);        // список заявок
setInterval(() => { Object.keys(openIds).forEach(id => refreshDialog(id).catch(() => {})); }, 2500); // живые диалоги
</script>
</body></html>`;
}
