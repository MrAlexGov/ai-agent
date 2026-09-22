import express from 'express';
import type { Store, TicketStatus } from '../storage/types';
import type { BotHandle } from '../bot/bot';
import type { Pipeline } from '../agent/pipeline';
import { config } from '../config';

/**
 * Мини-дашборд владельца (этап 7): одна страница — заявки, диалоги,
 * ответ клиенту, закрытие заявки. Basic Auth, если задан DASHBOARD_PASSWORD.
 */

export function startDashboard(
  store: Store,
  bot: BotHandle | null,
  pipeline: Pipeline | null
): void {
  const app = express();
  app.use(express.json());

  // Basic Auth (только если задан пароль; для локальных тестов можно без него)
  if (config.dashboardPassword) {
    app.use((req, res, next) => {
      const header = req.headers.authorization ?? '';
      const [scheme, b64] = header.split(' ');
      const pass = scheme === 'Basic' && b64 ? Buffer.from(b64, 'base64').toString('utf-8') : '';
      const entered = pass.split(':').slice(1).join(':'); // логин игнорируем, важен пароль
      if (scheme === 'Basic' && entered === config.dashboardPassword) return next();
      res.setHeader('WWW-Authenticate', 'Basic realm="Owner dashboard"');
      res.status(401).send('Требуется авторизация');
    });
  } else {
    console.warn('[dashboard] DASHBOARD_PASSWORD не задан — дашборд БЕЗ пароля (только для локальных тестов!)');
  }

  // ---------- REST API ----------

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

/** Одностраничный интерфейс дашборда (тёмная тема, автoобновление 10 с). */
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
<div class="sub">Новые заявки и эскалации. Ответ уходит клиенту в Telegram. Обновление каждые 10 с.</div>
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
document.getElementById('filters').onclick = (e) => {
  if (e.target.dataset.s === undefined) return;
  filter = e.target.dataset.s;
  document.querySelectorAll('.filters button').forEach(b => b.classList.toggle('on', b === e.target));
  load();
};
async function api(path, opts) { const r = await fetch(path, opts); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; }
function esc(s) { return (s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function roleLabel(r) { return {user:'👤 клиент', bot:'🤖 бот', owner:'👩‍💼 менеджер'}[r] || r; }

async function load() {
  try {
    const tickets = await api('/api/tickets' + (filter ? '?status=' + filter : ''));
    if (!tickets.length) { $list.innerHTML = '<div class="empty">Заявок пока нет 🎉</div>'; return; }
    $list.innerHTML = tickets.map(t =>
      '<div class="card" id="c' + t.id + '">' +
        '<div class="row"><span class="id">#' + t.id + ' ' + (t.kind === 'handoff' ? '🚨 эскалация' : '🧾 заявка') + '</span>' +
        '<span class="status ' + t.status + '">' + ({new:'новая', in_progress:'в работе', done:'закрыта'}[t.status]) + '</span></div>' +
        '<div class="meta">' + esc(t.userName || 'без имени') + (t.username ? ' · @' + esc(t.username) : '') + (t.contact ? ' · 📞 ' + esc(t.contact) : '') + ' · ' + new Date(t.createdAt).toLocaleString('ru-RU') + '</div>' +
        '<div class="topic">' + esc(t.topic || '') + '</div>' +
        '<div class="row" style="margin-top:10px">' +
          '<button class="btn" onclick="toggle(' + t.id + ', this)">💬 Диалог</button>' +
          (t.status !== 'done' ? '<button class="btn close" onclick="closeTicket(' + t.id + ')">✔ Закрыть</button>' : '') +
        '</div>' +
        '<div class="dialog" id="d' + t.id + '"></div>' +
      '</div>').join('');
  } catch (e) { $list.innerHTML = '<div class="empty">Ошибка: ' + esc(e.message) + '</div>'; }
}

async function toggle(id, btn) {
  const box = document.getElementById('d' + id);
  if (!box) return;
  if (box.style.display === 'block') { box.style.display = 'none'; btn.textContent = '💬 Диалог'; return; }
  const data = await api('/api/tickets/' + id + '/dialog');
  const open = data.ticket.status !== 'done';
  box.innerHTML =
    '<div id="dlg' + id + '">' +
      data.dialog.map(m =>
        '<div class="msg ' + m.role + '"><b>' + roleLabel(m.role) + ':</b> ' + esc(m.text) + '</div>').join('') +
    '</div>' +
    (open
      ? '<div class="replybox" style="display:flex;margin-top:10px">' +
          '<textarea id="t' + id + '" placeholder="Ответ клиенту — уйдёт в Telegram от менеджера…"></textarea></div>' +
        '<div style="text-align:right;margin-top:6px"><button class="btn" onclick="reply(' + id + ')">Отправить ➤</button></div>'
      : '<div class="meta" style="margin-top:8px">Заявка закрыта — поле ответа скрыто.</div>');
  box.style.display = 'block';
  btn.textContent = '▲ Свернуть';
}

async function reply(id) {
  const ta = document.getElementById('t' + id);
  const text = (ta.value || '').trim();
  if (!text) return alert('Введите текст');
  try {
    await api('/api/tickets/' + id + '/reply', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
    ta.value = '';
    const dlg = document.getElementById('dlg' + id);
    const data = await api('/api/tickets/' + id + '/dialog');
    dlg.innerHTML = data.dialog.map(m =>
      '<div class="msg ' + m.role + '"><b>' + roleLabel(m.role) + ':</b> ' + esc(m.text) + '</div>').join('');
    setTimeout(load, 500);
  } catch (e) { alert('Ошибка: ' + e.message); }
}

async function closeTicket(id) {
  if (!confirm('Закрыть заявку #' + id + '? Бот вернётся в чат.')) return;
  try { await api('/api/tickets/' + id + '/close', { method:'POST' }); load(); }
  catch (e) { alert('Ошибка: ' + e.message); }
}
load();
setInterval(load, 10000);
</script>
</body></html>`;
}
