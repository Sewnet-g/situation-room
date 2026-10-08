const API = `http://127.0.0.1:${new URLSearchParams(location.search).get('port') || 7777}`;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LABEL = { idle: '', working: 'Working', waiting: 'Needs you', done: 'Done', stopped: 'Stopped' };
const KIND = { task: 'Task', review: 'Review', address: 'Feedback', jira: 'Ticket' };
const EVL = { COMMENT: 'Comment', APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes' };

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let tasks = [];
let current = store.get('current', null);
let tab = store.get('tab', 'claude');
let mode = store.get('mode', 'tasks');
let drawerOpen = store.get('drawer', '1') === '1';
let review = null; // panel data for a review task
let fb = null; // panel data for an address-feedback task
let ship = null; // panel data for the Ship tab
let changes = null; // panel data for the Changes tab
let prWatch = { items: [] };
let saveTimer;
let config = {};
const terms = new Map(); // `${id}:${kind}` -> { term, fit, el, attached }
let ws;

const kindOf = (t) => t?.kind || (t?.pr ? 'review' : 'task');
// Feedback on your own PR: on an address task, or adopted by the task that made the branch.
const hasFb = (t) => kindOf(t) === 'address' || !!t?.fb;
const prOf = (t) => t?.fb?.pr || t?.pr;
const prKey = (t) => prOf(t) && `${prOf(t).slug.toLowerCase()}#${prOf(t).number}`;
// Spaces (spaces.js) narrow which tasks are visible and how they notify.
const hooks = { visible: (t) => true, notify: (t, title, body) => [title, body], newTask: () => ({}), badge: (t) => true, work: () => true, roots: () => config.roots, pi: () => true, login: (t) => false };
const shown = () => tasks.filter((t) => hooks.visible(t));
const cur = () => tasks.find((x) => x.id === current);
const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');
const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (login) => `<span class="av" style="--h:${hue(login)}">${esc(String(login).slice(0, 2).toUpperCase())}</span>`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const svg = (d) => `<svg viewBox="0 0 16 16" class="ic">${d}</svg>`;
const ICON = {
  task: svg('<path d="M3 4.5 6 7.5 3 10.5M7.5 11h5"/>'),
  review: svg('<path d="M1.8 8s2.2-4.2 6.2-4.2S14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>'),
  address: svg('<path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5a1.5 1.5 0 0 1-1.5 1.5H7.2L4.5 13v-2.5A1.5 1.5 0 0 1 2.5 9z"/>'),
  jira: svg('<path d="M2.5 5.5V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1.5a1.5 1.5 0 0 0 0 3V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V8.5a1.5 1.5 0 0 0 0-3zM9.5 3v10"/>'),
  pin: svg('<path d="M8 2l1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2l-3.6 1.9.7-4L2.2 6.3l4-.6z"/>'),
  ship: svg('<path d="M8 13.5V3M4 6.5 8 2.5l4 4M3 13.5h10"/>'),
  branch: svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5 3.5"/>'),
  commit: svg('<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>'),
  spark: svg('<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M4.2 11.8l1.6-1.6M10.2 5.8l1.6-1.6"/>'),
};

async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(API + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(out?.error || out || `HTTP ${r.status}`);
  return out;
}

function toast(html, kind = '', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}

function confirmSheet({ title, body, ok = 'Confirm', danger }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet confirm';
    d.innerHTML = `<h3>${title}</h3><div class="cb">${body}</div>
      <menu><button class="ghost" value="no">Cancel</button><button class="${danger ? 'danger-btn' : 'primary'}" value="ok">${ok}</button></menu>`;
    document.body.appendChild(d);
    d.querySelectorAll('menu button').forEach((b) => (b.onclick = () => d.close(b.value)));
    d.onclose = () => { resolve(d.returnValue === 'ok'); d.remove(); };
    d.showModal();
    d.querySelector('menu button:last-child').focus();
  });
}

function ago(v) {
  const t = typeof v === 'number' ? v : Date.parse(v);
  const m = (Date.now() - t) / 60000;
  if (m < 1) return 'just now';
  return m < 60 ? `${Math.round(m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function autogrow(ta) {
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
}

// ---- Connection ----

function connect() {
  ws = new WebSocket(API.replace('http', 'ws') + '/ws');
  ws.onmessage = (e) => onMsg(JSON.parse(e.data));
  // Daemon restarts drop the socket; reattach terminals once it is back.
  ws.onclose = () => setTimeout(() => { for (const x of terms.values()) x.attached = false; connect(); }, 1000);
  ws.onopen = () => mode === 'tasks' && show();
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function onMsg(m) {
  if (m.t === 'tasks') {
    tasks = m.tasks;
    if (current && !shown().some((t) => t.id === current)) current = null;
    renderSidebar();
    // onopen fires before the task list arrives; show once it is here.
    if (mode === 'tasks' && !terms.has(`${current}:${tab}`) && tab !== 'diff') show(); else renderBar();
  } else if (m.t === 'out' || m.t === 'replay') {
    const x = terms.get(`${m.id}:${m.kind}`);
    if (!x) return;
    if (m.t === 'replay') x.term.reset();
    x.term.write(m.data);
  } else if (m.t === 'exit') {
    const x = terms.get(`${m.id}:${m.kind}`);
    if (x) { x.term.write('\r\n\x1b[2m[process exited — ⋯ → Restart terminal to relaunch]\x1b[0m\r\n'); x.attached = false; }
  } else if (m.t === 'attention') {
    const t = tasks.find((x) => x.id === m.id);
    if (t && (m.id !== current || mode !== 'tasks' || !document.hasFocus())) {
      window.sr?.notify(...hooks.notify(t, `${t.name} — ${LABEL[m.status] || m.status}`, m.message || t.repo));
    }
    if (m.id === current && mode === 'tasks' && document.hasFocus()) send({ t: 'seen', id: m.id });
  } else if (m.t === 'prwatch') {
    onWatch(m);
  } else if (m.t === 'review' && m.id === current) {
    // Skip our own saves echoing back while the user is typing.
    if (!document.activeElement?.closest('#drawer')) loadPanel(true);
  }
}

// ---- Sidebar ----

function groups() {
  const g = new Map();
  const q = ($('#q')?.value || '').trim().toLowerCase();
  for (const t of shown()) {
    if (q && !`${t.name} ${t.repo} ${t.label || ''} ${t.branch || ''}`.toLowerCase().includes(q)) continue;
    const k = t.pinned ? '★' : t.repo;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(t);
  }
  return [...g.entries()].sort(([a], [b]) => (a === '★' ? -1 : b === '★' ? 1 : a.localeCompare(b)));
}
const ordered = () => groups().flatMap(([, ts]) => ts);

function renderSidebar() {
  const box = $('#tasks');
  const order = ordered();
  box.innerHTML = '';
  for (const [name, ts] of groups()) {
    box.insertAdjacentHTML('beforeend', `<div class="group"><span>${name === '★' ? 'Pinned' : esc(name)}</span><em>${ts.length}</em></div>`);
    for (const t of ts) {
      const i = order.indexOf(t);
      const k = kindOf(t);
      const el = document.createElement('div');
      el.dataset.id = t.id;
      el.className = `task st-${t.status}` + (t.id === current ? ' active' : '') + (t.harness === 'pi' ? ' h-pi' : '');
      const sub = LABEL[t.status] ? `<b>${LABEL[t.status]}</b>${t.updatedAt ? ` · ${ago(t.updatedAt)}` : ''}` : esc(t.label || KIND[k]);
      el.innerHTML = `<span class="ico k-${k}">${t.pinned ? ICON.pin : ICON[k]}<i class="dot ${t.status}"></i>${t.harness === 'pi' ? '<i class="pib" title="Pi">π</i>' : ''}</span>
        <span class="tx"><span class="name">${esc(t.name)}</span><span class="sub">${sub}</span></span>
        ${i < 9 ? `<kbd>⌘${i + 1}</kbd>` : ''}`;
      el.onclick = () => select(t.id);
      box.appendChild(el);
    }
  }
  const need = (s) => s.filter((t) => t.status === 'waiting' || t.status === 'done').length;
  $('#n-tasks').textContent = need(shown()) || '';
  window.sr?.badge(need(tasks.filter((t) => hooks.badge(t))));
}

// ---- Task view ----

function renderBar() {
  const t = cur();
  $('#empty').hidden = !!t;
  $('#bar').hidden = !t;
  $('#work').hidden = !t;
  if (!t) return;
  const k = kindOf(t);
  $('#title').innerHTML = `<span class="ico k-${k}">${t.pinned ? ICON.pin : ICON[k]}${t.harness === 'pi' ? '<i class="pib">π</i>' : ''}</span>
    <div><b>${esc(t.name)}</b><small>${esc(t.label || t.branch || tilde(t.cwd))}${t.harness === 'pi' || t.model ? ` · ${t.harness === 'pi' ? 'Pi' : 'Claude'}${t.model ? ` ${esc(modelLabel(t.model))}` : ''}` : ''}</small></div>`;
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  $('#remove').hidden = t.id === 'builder';
  const panel = hasPanel(t);
  $('#reviewbtn').hidden = !panel;
  $('#rlabel').textContent = k === 'review' ? 'Review' : PTAB[ptabOf(t)];
  $('#reviewbtn').classList.toggle('on', panel && drawerOpen);
  $('#prlink').hidden = !prOf(t);
  if (prOf(t)) $('#prlink').href = prOf(t).url;
  $('#jiralink').hidden = !t.jira;
  if (t.jira) $('#jiralink').href = t.jira.url;
  const badge = $('#drawer .agent');
  if (badge) badge.outerHTML = agentBadge(t);
}

function agentBadge(t) {
  const txt = { working: 'Agent working', waiting: 'Agent needs you', done: 'Agent finished' }[t.status];
  return `<span class="agent ${t.status}">${txt ? `<i></i>${txt}` : ''}</span>`;
}

function select(id) {
  if (current !== id) { review = null; fb = null; }
  current = id;
  store.set('current', id);
  if (mode !== 'tasks') setMode('tasks');
  send({ t: 'seen', id });
  const t = cur();
  if (prKey(t)) markPrSeen(prKey(t));
  renderSidebar();
  show();
  refreshUsage();
}

// ---- PR watch ----

const watchOf = (slug, n) => prWatch.items.find((x) => x.key === `${slug.toLowerCase()}#${n}`);

function onWatch(m) {
  prWatch = m;
  const unread = m.items.filter((x) => x.unread);
  $('#ping-prs').hidden = !unread.length;
  $('#n-upd').textContent = unread.length || '';
  for (const k of m.fresh || []) {
    const x = m.items.find((i) => i.key === k);
    if (x) window.sr?.notify(`#${x.number} ${x.title}`, watchLine(x));
  }
  if (mode === 'prs' && typeof renderPrWatch === 'function') renderPrWatch();
}

function watchLine(x) {
  return [x.comments && plural(x.comments, 'new comment'), x.reviews && plural(x.reviews, 'review'), x.commits && plural(x.commits, 'new commit')].filter(Boolean).join(' · ');
}

function markPrSeen(key) {
  const x = prWatch.items.find((i) => i.key === key);
  if (!x?.unread) return;
  Object.assign(x, { comments: 0, reviews: 0, commits: 0, unread: 0 });
  onWatch({ ...prWatch, fresh: [] });
  api('/prwatch/seen', { method: 'POST', body: { key } }).catch(() => {});
}

function setTab(t) {
  tab = t;
  store.set('tab', t);
  show();
}

function term(id, kind) {
  const key = `${id}:${kind}`;
  if (terms.has(key)) return terms.get(key);
  const el = document.createElement('div');
  el.className = 'pane';
  $('#panes').appendChild(el);
  const term = new Terminal({
    fontFamily: '"SF Mono", ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.18, scrollback: 20000,
    macOptionIsMeta: true, allowProposedApi: true, cursorBlink: true,
    theme: {
      background: '#0f1115', foreground: '#dfe3ea', cursor: '#a99bff', cursorAccent: '#0f1115', selectionBackground: '#3b3566',
      black: '#1b1e25', brightBlack: '#5b6270', red: '#ff7a7a', green: '#5fd4a0', yellow: '#f2c46b', blue: '#7aa9ff',
      magenta: '#b99bff', cyan: '#62d0e0', white: '#dfe3ea',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData((data) => send({ t: 'in', id, kind, data }));
  term.onResize(({ cols, rows }) => send({ t: 'resize', id, kind, cols, rows }));
  const x = { term, fit, el, attached: false };
  terms.set(key, x);
  return x;
}

const refit = () => { for (const x of terms.values()) if (!x.el.hidden) x.fit.fit(); };

async function show() {
  renderBar();
  for (const x of terms.values()) x.el.hidden = true;
  const t = cur();
  const k = kindOf(t);
  $('#diff').hidden = !(t && tab === 'diff' && k !== 'review');
  $('#prdiff').hidden = !(t && tab === 'diff' && k === 'review');
  $('#panes').hidden = !t || tab === 'diff';
  const panel = hasPanel(t) && drawerOpen;
  $('#drawer').hidden = !panel;
  if (!t) return;
  renderDnav(t);
  if (panel || (k === 'review' && tab === 'diff')) await loadPanel();
  if (tab === 'diff') return k === 'review' ? renderPrDiff() : loadDiff(t);
  const x = term(t.id, tab);
  x.el.hidden = false;
  x.fit.fit();
  if (!x.attached && ws?.readyState === 1) {
    x.attached = true;
    send({ t: 'attach', id: t.id, kind: tab, cols: x.term.cols, rows: x.term.rows });
  }
  if (!document.activeElement?.closest('#drawer')) x.term.focus();
}

async function loadDiff(t) {
  $('#diff').innerHTML = '<div class="loading">Reading the working tree…</div>';
  const txt = await api(`/diff/${t.id}`).catch((e) => e.message);
  $('#diff').innerHTML = `<pre class="plain">${txt.split('\n').map((l) => {
    const c = l.startsWith('diff --git') ? 'file' : l.startsWith('@@') ? 'hunk'
      : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : '';
    return c ? `<span class="${c}">${esc(l)}</span>` : esc(l);
  }).join('\n')}</pre>`;
}

// ---- Agent choice (harness, model, effort); the last pick is the default everywhere ----

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
function agentChoice() { try { return JSON.parse(store.get('agent', '{}')); } catch { return {}; } }
const price = (m) => (m.cost[0] ? `$${m.cost[0]}/$${m.cost[1]}` : m.pi && !config.gateway ? 'Pi pricing' : 'free');
const modelLabel = (id) => (config.models || []).find((m) => m.id === id)?.label || String(id || '').replace(/^.*claude-/, '');

// Fills el with harness/model/effort selects; returns a getter for the current choice.
function agentPicker(el, { compact } = {}) {
  const c = agentChoice();
  const draw = () => {
    if (!hooks.pi()) c.harness = 'claude';
    const pi = c.harness === 'pi';
    const models = (config.models || []).filter((m) => (pi ? m.pi : m.claude));
    if (!models.some((m) => m.id === c.model)) c.model = pi ? config.piModel : '';
    el.innerHTML = `${compact ? '' : '<span class="lbl">Agent</span>'}
      <select data-k="harness" title="Harness"><option value="claude">Claude Code</option>${hooks.pi() ? `<option value="pi" ${pi ? 'selected' : ''}>Pi</option>` : ''}</select>
      <select data-k="model" title="${pi && !models.length ? 'Pi has no sign-in yet: run /login inside a Pi task' : 'Model · $ per 1M tokens in/out'}">${pi && models.length ? '' : `<option value="">${pi ? 'Pi default (run /login first)' : 'Default model'}</option>`}${models.map((m) =>
        `<option value="${esc(m.id)}" ${m.id === c.model ? 'selected' : ''}>${esc(m.label)} · ${price(m)}</option>`).join('')}</select>
      <select data-k="effort" title="${pi ? 'Thinking level' : 'Effort'}"><option value="">${compact ? 'Effort' : 'Default effort'}</option>${EFFORT.map((x) =>
        `<option ${x === c.effort ? 'selected' : ''}>${x}</option>`).join('')}</select>`;
    // A choice made where Pi is hidden is not remembered as the default elsewhere.
    for (const s of $$('select', el)) s.onchange = () => { c[s.dataset.k] = s.value; if (hooks.pi()) store.set('agent', JSON.stringify(c)); draw(); };
  };
  draw();
  return () => ({ harness: c.harness || 'claude', model: c.model || undefined, effort: c.effort || undefined });
}

// Asks for harness, model, repo and an optional session before a PR or Jira task starts; null when cancelled.
function startSheet({ title, sub, repos, repo, ok = 'Start task' }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet start';
    d.innerHTML = `<form method="dialog"><h3>${title}</h3>${sub ? `<p class="ss-sub">${sub}</p>` : ''}
      ${repos ? `<label>Repo <select name="repo">${repos.map((r) => `<option value="${esc(r.path)}" ${r.name === repo ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>`
        : `<label>Repo <input value="${esc(repo || '')}" disabled></label>`}
      <div class="agentpick"></div>
      <label>Resume session ID <input name="resume" placeholder="Optional; carries an earlier conversation in" autocomplete="off" spellcheck="false"></label>
      <label class="row" hidden><input type="checkbox" name="fork"> Fork it, so the original session stays as it is</label>
      <menu><button value="cancel" formnovalidate class="ghost">Cancel</button><button value="ok" class="primary">${ok}</button></menu></form>`;
    document.body.appendChild(d);
    const agent = agentPicker(d.querySelector('.agentpick'));
    const f = d.querySelector('form');
    f.resume.oninput = () => { f.fork.closest('label').hidden = !f.resume.value.trim(); };
    d.onclose = () => {
      const v = d.returnValue === 'ok' && { ...agent(), repoPath: f.repo?.value, resumeId: f.resume.value.trim() || undefined, fork: f.fork.checked || undefined };
      d.remove();
      resolve(v || null);
    };
    d.showModal();
    d.querySelector('menu .primary').focus();
  });
}

async function newTask() {
  const repos = await api(`/repos${hooks.newTask().space ? `?space=${hooks.newTask().space}` : ''}`);
  // Root folders are offered too, for tasks that span several repos.
  $('#repos').innerHTML = [...(hooks.roots() || []).map((r) => tilde(r)), ...repos.map((r) => r.name)].map((v) => `<option value="${esc(v)}">`).join('');
  $('#err').textContent = '';
  $('#form').reset();
  const agent = agentPicker($('#dlgagent'));
  $('#dlgbrowse').hidden = !window.sr?.pickFolder;
  $('#dlgbrowse').onclick = async () => {
    const p = await window.sr.pickFolder((hooks.roots() || [])[0]);
    if (p) { $('#form').repo.value = tilde(p); if (!$('#form').name.value) $('#form').name.value = p.split('/').pop(); }
  };
  $('#dlg').showModal();
  $('#dlg').onclose = async () => {
    if ($('#dlg').returnValue !== 'ok') return;
    const f = new FormData($('#form'));
    const input = f.get('repo').trim();
    const repoPath = repos.find((r) => r.name === input)?.path || (/^[~/]/.test(input) || /^[\w.-]+\/[\w.-]+$/.test(input) ? input : null);
    if (!repoPath) { $('#err').textContent = 'Unknown repo. Pick one, give owner/name to clone, or an absolute path.'; return $('#dlg').showModal(); }
    try {
      const t = await api('/tasks', {
        method: 'POST',
        body: { name: f.get('name'), repoPath, worktree: f.get('worktree') === 'on', resumeId: f.get('resume').trim() || undefined, fork: f.get('fork') === 'on' || undefined, ...agent(), ...hooks.newTask() },
      });
      tab = 'claude';
      select(t.id);
    } catch (e) { $('#err').textContent = e.message; $('#dlg').showModal(); }
  };
}

const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtUsd = (n) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

async function refreshUsage() {
  if (!window.sr?.usage) return;
  const t = cur();
  const u = await window.sr.usage(tasks.map((x) => x.sessionId)).catch(() => null);
  if (!u) return;
  const s = t && u.sessions[t.sessionId];
  $('#usage').hidden = false;
  $('#u-task').textContent = t ? `${t.name}${s?.model || t.model ? ` · ${modelLabel(s?.model || t.model)}` : ''}` : 'No task selected';
  $('#u-ctx').textContent = s?.context ? fmtTok(s.context) : '–';
  $('#u-tok').textContent = s ? `${fmtTok(s.input + s.cacheWrite + s.cacheRead)} / ${fmtTok(s.output)}` : '–';
  const m = config.models?.find((x) => x.id === (s?.model || t?.model));
  $('#u-cost').textContent = !s ? '–' : t && hooks.login(t) ? 'Subscription' : !s.cost && m && !m.cost.some(Boolean) ? 'Free' : fmtUsd(s.cost);
  $('#u-mlabel').textContent = u.monthLabel;
  $('#u-month').textContent = fmtUsd(u.month.cost);
  // Harness split shows once Pi has been used this month.
  const { claude: c, pi: p } = u.by || {};
  $('#u-split').hidden = !p?.turns;
  if (p?.turns) {
    const tok = (x) => x.input + x.cacheWrite + x.cacheRead + x.output;
    const share = c.cost + p.cost ? p.cost / (c.cost + p.cost) : 0;
    $('#u-barc').style.flex = String(1 - share);
    $('#u-barp').style.flex = String(share || 0.002);
    $('#u-claude').textContent = `${fmtUsd(c.cost)} · ${fmtTok(tok(c))}`;
    $('#u-pi').textContent = `${fmtUsd(p.cost)} · ${fmtTok(tok(p))}`;
  }
}

function setMode(m) {
  mode = m;
  store.set('mode', m);
  for (const b of $$('#modes button')) b.classList.toggle('on', b.dataset.mode === m);
  $('#taskview').hidden = m !== 'tasks';
  $('#prview').hidden = m !== 'prs';
  $('#jiraview').hidden = m !== 'jira';
  if (m === 'prs') loadPrView();
  else if (m === 'jira') loadJira();
  else show();
}

// ---- Side panel (review / feedback) ----

const PTAB = { feedback: 'Feedback', changes: 'Changes', ship: 'Ship' };
const hasPanel = (t) => !!t && (kindOf(t) === 'review' || !!t.git || hasFb(t));
const ptabsOf = (t) => (kindOf(t) === 'review' ? [] : hasFb(t) ? ['feedback', 'changes', 'ship'] : ['changes', 'ship']);
function ptabOf(t) {
  const v = store.get(`ptab:${kindOf(t)}`, null);
  const all = ptabsOf(t);
  return all.includes(v) ? v : all[0];
}

function renderDnav(t) {
  const tabs = ptabsOf(t);
  const nav = $('#dnav');
  nav.hidden = !tabs.length;
  const on = ptabOf(t);
  nav.innerHTML = tabs.map((x) => `<button data-p="${x}" class="${x === on ? 'on' : ''}">${PTAB[x]}<em id="dn-${x}"></em></button>`).join('');
  for (const b of $$('button', nav)) b.onclick = () => setPtab(b.dataset.p);
}

function setPtab(p) {
  const t = cur();
  if (!t) return;
  store.set(`ptab:${kindOf(t)}`, p);
  if (!drawerOpen) { drawerOpen = true; store.set('drawer', '1'); }
  show().then(refit);
}

function loadPanel(force) {
  const t = cur();
  const k = kindOf(t);
  if (k === 'review') return loadReview(force);
  const p = ptabOf(t);
  if (p === 'feedback') return loadFeedback(force);
  if (p === 'changes') return loadChanges(force);
  if (p === 'ship') return loadShip(force);
}

function toggleDrawer() {
  if (!hasPanel(cur())) return;
  drawerOpen = !drawerOpen;
  store.set('drawer', drawerOpen ? '1' : '0');
  show().then(refit);
}

async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (review?.id === current) await api(`/review/${review.id}`, { method: 'PUT', body: review.draft });
  if (fb?.id === current) await api(`/address/${fb.id}`, { method: 'PUT', body: fb.draft });
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave().catch((e) => toast(esc(e.message), 'bad')), 400);
}

async function askAgent(text) {
  const t = cur();
  await flushSave();
  try {
    await api(`/${kindOf(t) === 'review' ? 'review' : 'address'}/${t.id}/ask`, { method: 'POST', body: { text } });
    toast('Sent to the agent. Its edits land here as it works.', 'ok');
  } catch (e) { toast(esc(e.message), 'bad'); }
}

function composer(el, chips) {
  el.innerHTML = `<div class="chips">${chips.map((c, i) => `<button class="chip" data-i="${i}" title="${esc(c.title || '')}">${ICON.spark}${esc(c.label)}</button>`).join('')}</div>
    <div class="ask"><textarea rows="1" placeholder="Ask the agent…"></textarea><button class="send" title="Send (↵)">↑</button></div>`;
  const ta = el.querySelector('textarea');
  autogrow(ta);
  const go = () => { const v = ta.value.trim(); if (!v) return; ta.value = ''; askAgent(chips.wrap ? chips.wrap(v) : v); };
  el.querySelector('.send').onclick = go;
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
  el.querySelectorAll('.chip').forEach((b) => (b.onclick = async () => {
    const c = chips[b.dataset.i];
    if (c.before) await c.before();
    askAgent(c.text);
  }));
}

function emptyState(title, body) {
  return `<div class="empty-s"><div class="es-mark"></div><b>${title}</b><span>${body}</span></div>`;
}

// ---- Review panel ----

async function loadReview(force) {
  const t = cur();
  if (kindOf(t) !== 'review') return;
  if (review?.id === t.id && !force) return renderReview();
  if (review?.id !== t.id) $('#dbody').innerHTML = '<div class="loading">Loading the pull request…</div>';
  try {
    const r = await api(`/review/${t.id}`);
    if (current !== t.id) return;
    review = { id: t.id, ...r, lines: parseDiff(r.diff) };
  } catch (e) { $('#dbody').innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  renderReview();
  if (tab === 'diff') renderPrDiff();
}

// Maps each diff line to its file/side/line so comments can be anchored and previewed.
function parseDiff(txt) {
  const out = [];
  let file, o = 0, n = 0;
  for (const l of txt.split('\n')) {
    if (l.startsWith('diff --git')) { file = l.split(' b/').pop(); out.push({ kind: 'file', file }); continue; }
    if (l.startsWith('+++ ') || l.startsWith('--- ') || l.startsWith('index ') || /^(new|deleted) file|^similarity|^rename|^Binary/.test(l)) continue;
    const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (h) { o = +h[1]; n = +h[2]; out.push({ kind: 'hunk', file, text: l }); continue; }
    if (!file) continue;
    if (l.startsWith('+')) out.push({ kind: 'add', file, side: 'RIGHT', line: n++, text: l });
    else if (l.startsWith('-')) out.push({ kind: 'del', file, side: 'LEFT', line: o++, text: l });
    else if (l.startsWith(' ') || l === '') out.push({ kind: 'ctx', file, side: 'RIGHT', line: n++, old: o++, text: l });
  }
  return out;
}

const inRange = (l, c) => l.file === c.path && l.side === (c.side || 'RIGHT') && l.line <= c.line && l.line >= (c.start_line || c.line);
function findLine(c) {
  return review.lines.findIndex((l) => l.file === c.path && l.side === (c.side || 'RIGHT') && l.line === c.line);
}

function snippet(c) {
  const i = findLine(c);
  if (i < 0) return '<pre class="snip warn">This line is outside the diff, so GitHub will reject the comment.</pre>';
  const span = c.start_line ? c.line - c.start_line : 0;
  const rows = review.lines.slice(Math.max(0, i - span - 2), i + 3).filter((l) => l.kind !== 'file' && l.kind !== 'hunk' && l.file === c.path);
  return `<pre class="snip">${rows.map((l) => `<span class="${l.kind}${inRange(l, c) ? ' hl' : ''}"><i>${l.line}</i>${esc(l.text || ' ')}</span>`).join('')}</pre>`;
}

const suggestionOf = (body) => (/```suggestion/.test(body) ? md(body.slice(body.indexOf('```suggestion'))) : '');

function renderReview() {
  const d = $('#dbody');
  const t = cur();
  if (!review || $('#drawer').hidden || review.id !== current) return;
  const dr = review.draft;
  dr.comments ||= [];
  const live = dr.comments.filter((c) => !c.skip && c.body.trim());
  const hist = dr.history || [];
  $('#rcount').textContent = dr.comments.length ? live.length : '';
  const ev = dr.event || 'COMMENT';
  const empty = t.status === 'working'
    ? `<div class="skel"><i></i><i></i><i></i></div><p class="hint">Reading the PR. Comments appear here as they are drafted.</p>`
    : hist.length
      ? emptyState('Draft is clear', 'Your last review is posted. Ask for another pass below, or click a line in the Diff tab to comment.')
      : emptyState('No comments yet', 'The agent drafts them here. You can also click any line in the Diff tab.');
  d.innerHTML = `
    <header class="dh">
      <div><h4>Your review</h4><small>#${review.pr.number} · @${esc(review.pr.author)}</small></div>
      ${agentBadge(t)}
    </header>
    <div class="db">
      ${hist.length ? `<details class="hist"><summary>${plural(hist.length, 'posted review')}</summary>${hist.slice().reverse().map((h) =>
        `<a class="hrow" href="${esc(h.url)}"><span class="ev ev-${h.event}">${EVL[h.event] || h.state}</span>
          <span>${plural((h.comments || []).length, 'comment')}</span><span class="dim">${ago(h.at)}</span><span class="ext">↗</span></a>`).join('')}</details>` : ''}
      <label class="lbl">Summary</label>
      <textarea id="rv-summary" rows="2" placeholder="Overall comment (optional)">${esc(dr.summary || '')}</textarea>
      <div class="lbl row"><span>Inline comments</span>${dr.comments.length ? `<span class="dim">${live.length} of ${dr.comments.length} included</span>` : ''}</div>
      <div id="rv-list">${dr.comments.length ? '' : empty}</div>
    </div>
    <div class="composer" id="rv-ask"></div>
    <footer class="df">
      <div class="seg small" id="rv-event">${Object.keys(EVL).map((e) => `<button data-e="${e}" class="${ev === e ? 'on' : ''} e-${e}">${EVL[e]}</button>`).join('')}</div>
      <button id="rv-submit" class="primary">Submit</button>
    </footer>
    <div class="who">Posts on GitHub as <b>@${esc(review.login)}</b></div>`;
  const sum = $('#rv-summary');
  autogrow(sum);
  sum.oninput = () => { dr.summary = sum.value; persist(); updateSubmit(); };
  for (const b of $$('#rv-event button')) b.onclick = () => { dr.event = b.dataset.e; persist(); renderReview(); };
  $('#rv-submit').onclick = submit;
  const file = t.reviewFile;
  composer($('#rv-ask'), Object.assign([
    { label: 'Look again', text: `Take another pass over the PR for anything important that is not already in the draft or history. Add new comments to ${file} and keep the existing ones.` },
    { label: 'New commits', text: `The PR may have new commits since the last posted review. Run gh pr diff again, review only what changed since then, and add comments for it to ${file}. Do not repeat anything in history.` },
    { label: 'Tighten wording', text: `Make every comment in ${file} shorter and more direct without losing its point.` },
  ], { wrap: (v) => `${v} (Draft file: ${file})` }));
  const list = $('#rv-list');
  dr.comments.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'cm' + (c.skip ? ' off' : '');
    const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/') + 1) : '';
    const range = c.start_line ? `${c.start_line}–${c.line}` : c.line;
    el.innerHTML = `<div class="ch"><a class="loc" title="Show in diff"><span class="dir">${esc(dir)}</span><b>${esc(c.path.slice(dir.length))}</b><span class="ln">:${range}${c.side === 'LEFT' ? ' old' : ''}</span></a>
      <button class="ghost icon xs" data-a="refine" title="Ask the agent to rework this">${ICON.spark}</button>
      <button class="ghost xs" data-a="skip">${c.skip ? 'Include' : 'Skip'}</button>
      <button class="ghost icon xs" data-a="del" title="Delete">✕</button></div>
      ${snippet(c)}
      <textarea rows="2" placeholder="Write a comment…">${esc(c.body)}</textarea>
      <div class="sp">${suggestionOf(c.body)}</div>
      <div class="refine" hidden><input placeholder="How should it change? e.g. softer, propose a fix"><button class="xs primary">Send</button></div>`;
    el.querySelector('.loc').onclick = () => jumpTo(c);
    el.querySelector('[data-a=skip]').onclick = () => { c.skip = !c.skip; persist(); renderReview(); renderPrDiff(); };
    el.querySelector('[data-a=del]').onclick = () => { dr.comments.splice(i, 1); persist(); renderReview(); renderPrDiff(); };
    const ta = el.querySelector('textarea');
    autogrow(ta);
    ta.oninput = () => { c.body = ta.value; el.querySelector('.sp').innerHTML = suggestionOf(c.body); persist(); updateSubmit(); };
    const rf = el.querySelector('.refine');
    el.querySelector('[data-a=refine]').onclick = () => { rf.hidden = !rf.hidden; if (!rf.hidden) rf.querySelector('input').focus(); };
    const sendRefine = () => {
      const v = rf.querySelector('input').value.trim();
      if (!v) return;
      rf.hidden = true;
      askAgent(`Rework your draft comment on ${c.path} line ${c.line} (it starts "${c.body.slice(0, 60)}"): ${v}. Edit it in place in ${file} and leave the other comments alone.`);
    };
    rf.querySelector('button').onclick = sendRefine;
    rf.querySelector('input').onkeydown = (e) => { if (e.key === 'Enter') sendRefine(); };
    list.appendChild(el);
  });
  updateSubmit();
}

function updateSubmit() {
  const dr = review.draft;
  const live = dr.comments.filter((c) => !c.skip && c.body.trim());
  const ok = live.length || dr.summary?.trim() || dr.event === 'APPROVE';
  const b = $('#rv-submit');
  if (!b) return;
  b.disabled = !ok;
  b.textContent = `${EVL[dr.event || 'COMMENT'] === 'Comment' ? 'Submit' : EVL[dr.event]}${live.length ? ` · ${live.length}` : ''}`;
}

function renderPrDiff() {
  if (!review || tab !== 'diff' || review.id !== current) return;
  const box = $('#prdiff');
  const top = box.scrollTop;
  const at = new Map();
  for (const c of review.draft.comments || []) {
    const k = `${c.path}|${c.side || 'RIGHT'}|${c.line}`;
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(c);
  }
  const frag = document.createDocumentFragment();
  let n = 0;
  review.lines.forEach((l) => {
    if (l.kind === 'file') {
      const h = document.createElement('div');
      h.className = 'dfile';
      h.innerHTML = `<span class="mono">${esc(l.file)}</span>`;
      frag.appendChild(h);
      return;
    }
    const el = document.createElement('div');
    const k = `${l.file}|${l.side}|${l.line}`;
    const has = (review.draft.comments || []).some((c) => inRange(l, c));
    el.className = `dl ${l.kind}${has ? ' has' : ''}`;
    el.dataset.k = k;
    el.innerHTML = l.kind === 'hunk' ? `<span class="n"></span><span class="n"></span><span class="c">${esc(l.text)}</span>`
      : `<span class="n">${l.kind === 'add' ? '' : l.old ?? l.line}</span><span class="n">${l.kind === 'del' ? '' : l.line}</span><span class="c">${esc(l.text)}</span><span class="plus">+</span>`;
    if (l.kind !== 'hunk') el.onclick = () => addComment(l);
    frag.appendChild(el);
    for (const c of at.get(k) || []) {
      const cm = document.createElement('div');
      cm.className = 'inl' + (c.skip ? ' off' : '');
      cm.innerHTML = `<div class="inl-h">${avatar(review.login)}<b>@${esc(review.login)}</b><span class="dim">draft${c.skip ? ' · skipped' : ''}</span></div><div class="md">${md(c.body) || '<p class="dim">Empty comment</p>'}</div>`;
      cm.onclick = () => focusComment(c);
      frag.appendChild(cm);
    }
    n++;
  });
  box.innerHTML = '';
  box.appendChild(frag);
  box.scrollTop = top;
}

function addComment(l) {
  const c = { path: l.file, line: l.line, side: l.side, body: '' };
  review.draft.comments.push(c);
  drawerOpen = true;
  store.set('drawer', '1');
  $('#drawer').hidden = false;
  renderBar();
  renderReview();
  renderPrDiff();
  focusComment(c);
}

function focusComment(c) {
  if ($('#drawer').hidden) { drawerOpen = true; $('#drawer').hidden = false; renderReview(); }
  const el = $('#rv-list').children[review.draft.comments.indexOf(c)];
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el?.querySelector('textarea').focus();
}

function jumpTo(c) {
  if (tab !== 'diff') setTab('diff');
  setTimeout(() => {
    const el = document.querySelector(`#prdiff .dl[data-k="${CSS.escape(`${c.path}|${c.side || 'RIGHT'}|${c.line}`)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1400);
  }, 60);
}

async function submit() {
  const dr = review.draft;
  const comments = (dr.comments || []).filter((c) => !c.skip && c.body.trim());
  const bad = comments.filter((c) => findLine(c) < 0);
  if (bad.length) return toast(`${plural(bad.length, 'comment')} point outside the diff. Fix or skip them first.`, 'bad');
  const ev = dr.event || 'COMMENT';
  const ok = await confirmSheet({
    title: `${EVL[ev]} on #${review.pr.number}?`,
    body: `<p>Posts to <b>${esc(review.pr.slug)}</b> as <b>@${esc(review.login)}</b>${comments.length ? ` with ${plural(comments.length, 'inline comment')}` : ''}.</p>
      ${dr.summary?.trim() ? `<blockquote>${esc(dr.summary.trim().slice(0, 240))}</blockquote>` : ''}`,
    ok: `Post ${EVL[ev].toLowerCase()}`,
  });
  if (!ok) return;
  await flushSave();
  $('#rv-submit').disabled = true;
  $('#rv-submit').textContent = 'Posting…';
  try {
    const out = await api(`/review/${review.id}/submit`, { method: 'POST', body: { event: ev, body: dr.summary || '', comments } });
    toast(`Review posted. <a href="${esc(out.url)}">View on GitHub ↗</a>`, 'ok', 6000);
  } catch (e) { toast(esc(e.message), 'bad', 8000); }
  loadReview(true);
}

// ---- Feedback panel (my PRs) ----

async function loadFeedback(force) {
  const t = cur();
  if (!hasFb(t)) return;
  if (fb?.id === t.id && !force) return renderFeedback();
  if (fb?.id !== t.id) $('#dbody').innerHTML = '<div class="loading">Fetching review threads…</div>';
  try {
    const r = await api(`/address/${t.id}${force === 'gh' ? '?force=1' : ''}`);
    if (current !== t.id) return;
    fb = { filter: fb?.id === t.id ? fb.filter : 'open', ...r, id: t.id };
  } catch (e) { $('#dbody').innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  renderFeedback();
}

function hunkTail(h) {
  const rows = h.split('\n').filter((l) => !l.startsWith('@@')).slice(-4);
  return `<pre class="snip">${rows.map((l) => `<span class="${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx'}">${esc(l || ' ')}</span>`).join('')}</pre>`;
}

function msg(c) {
  return `<div class="msg">${avatar(c.author)}<div class="mb"><div class="mh"><b>@${esc(c.author)}</b><span class="dim">${ago(c.at)}</span>
    ${c.url ? `<a class="ext" href="${esc(c.url)}" title="Open in browser">↗</a>` : ''}</div><div class="md">${md(c.body)}</div></div></div>`;
}

function renderFeedback() {
  const d = $('#dbody');
  const t = cur();
  if (!fb || $('#drawer').hidden || fb.id !== current || ptabOf(t) !== 'feedback') return;
  const dr = fb.draft;
  dr.replies ||= [];
  const reply = (id) => dr.replies.find((r) => r.thread === id);
  const dismissed = (id) => !!reply(id)?.dismissed;
  const open = fb.threads.filter((th) => !th.resolved && !dismissed(th.id));
  const shown = fb.filter === 'open' ? open : fb.threads;
  const general = fb.filter === 'open' ? fb.general.filter((g) => !dismissed(g.id)) : fb.general;
  $('#rcount').textContent = open.length || '';
  d.innerHTML = `
    <header class="dh">
      <div><h4>Feedback</h4><small>#${fb.pr.number} · ${esc(fb.branch)}</small></div>
      ${agentBadge(t)}
      <button class="ghost icon xs" id="fb-refresh" title="Fetch from GitHub">↻</button>
    </header>
    <div class="dsub"><div class="seg small" id="fb-filter">
      <button data-f="open" class="${fb.filter === 'open' ? 'on' : ''}">Open <em>${open.length}</em></button>
      <button data-f="all" class="${fb.filter === 'all' ? 'on' : ''}">All threads <em>${fb.threads.length}</em></button>
    </div><span class="dim">synced ${ago(fb.fetchedAt)}</span></div>
    <div class="db" id="fb-list"></div>
    <div class="changes" id="fb-changes"></div>
    <div class="composer" id="fb-ask"></div>
    <div class="who">Replies post on GitHub as <b>@${esc(fb.login)}</b></div>`;
  $('#fb-refresh').onclick = () => loadFeedback('gh');
  for (const b of $$('#fb-filter button')) b.onclick = () => { fb.filter = b.dataset.f; renderFeedback(); };
  const list = $('#fb-list');
  if (!shown.length && !general.length) {
    list.innerHTML = emptyState('Nothing open', 'New review comments show up here. ↻ fetches the latest from GitHub.');
  }
  const card = (id, head, convo, threadKind) => {
    const r = reply(id);
    const posted = r?.posted && r.posted.body === (r.body || '');
    const el = document.createElement('div');
    el.className = 'th' + (posted ? ' done' : '') + (r?.dismissed ? ' off' : '');
    el.innerHTML = `${head.replace(/<\/div>$/, `<button class="ghost xs" data-a="dismiss">${r?.dismissed ? 'Restore' : 'Dismiss'}</button></div>`)}${convo}
      <div class="reply">
        ${r?.fixed ? '<span class="tag ok">Fixed in code</span>' : ''}
        ${posted ? `<div class="posted">✓ Replied${r.posted.resolved ? ' and resolved' : ''} ${ago(r.posted.at)}${r.posted.url ? ` · <a href="${esc(r.posted.url)}">view ↗</a>` : ''}</div>` : ''}
        <textarea rows="2" placeholder="Reply…">${esc(r?.body || '')}</textarea>
        <div class="ra">${threadKind ? `<label class="check"><input type="checkbox" ${r?.resolve ? 'checked' : ''}> Resolve</label>` : '<span></span>'}
          <button class="xs primary" data-a="post">${posted ? 'Reply again' : 'Reply'}</button></div>
      </div>`;
    const ta = el.querySelector('textarea');
    autogrow(ta);
    const ensure = () => reply(id) || (dr.replies.push({ thread: id }), reply(id));
    ta.oninput = () => { ensure().body = ta.value; persist(); };
    el.querySelector('[data-a=dismiss]').onclick = () => { const x = ensure(); x.dismissed = !x.dismissed; persist(); renderFeedback(); };
    const cb = el.querySelector('input[type=checkbox]');
    if (cb) cb.onchange = () => { ensure().resolve = cb.checked; persist(); };
    el.querySelector('[data-a=post]').onclick = async (e) => {
      const body = ta.value.trim();
      const resolve = !!cb?.checked;
      if (!body && !resolve) return toast('Write a reply first.', 'bad');
      e.target.disabled = true;
      e.target.textContent = 'Posting…';
      try {
        await flushSave();
        await api(`/address/${fb.id}/reply`, { method: 'POST', body: { thread: id, body, resolve } });
        toast(resolve ? 'Replied and resolved.' : 'Reply posted.', 'ok');
      } catch (err) { toast(esc(err.message), 'bad', 7000); }
      loadFeedback(true);
    };
    list.appendChild(el);
  };
  for (const th of shown) {
    const head = `<div class="ch"><span class="loc"><b>${esc(th.path)}</b><span class="ln">:${th.line ?? '?'}</span></span>
      ${th.outdated ? '<span class="tag">outdated</span>' : ''}${th.resolved ? '<span class="tag ok">resolved</span>' : ''}</div>`;
    card(th.id, head, `${th.hunk ? hunkTail(th.hunk) : ''}<div class="convo">${th.comments.map(msg).join('')}</div>`, true);
  }
  if (general.length) list.insertAdjacentHTML('beforeend', '<div class="lbl">Conversation</div>');
  for (const g of general) {
    const st = { CHANGES_REQUESTED: '<span class="tag bad">changes requested</span>', APPROVED: '<span class="tag ok">approved</span>' }[g.state] || '';
    card(g.id, `<div class="ch"><span class="loc"><b>${g.kind === 'review' ? 'Review summary' : 'Comment'}</b></span>${st}</div>`,
      `<div class="convo">${msg(g)}</div>`, false);
  }
  const ch = $('#fb-changes');
  const n = fb.changed.length;
  ch.innerHTML = n || fb.ahead ? `<button class="shipnudge" id="fb-ship"><span>${ICON.ship}</span><span><b>${n ? plural(n, 'changed file') : 'Nothing uncommitted'}</b>
    <small>${fb.ahead ? `${fb.ahead} unpushed · ` : ''}commit and push from Ship</small></span><span class="go">›</span></button>` : '';
  if ($('#fb-ship')) $('#fb-ship').onclick = () => setPtab('ship');
  const tf = t.fb?.threads || t.threadsFile;
  const file = t.fb?.file || t.reviewFile;
  composer($('#fb-ask'), Object.assign([
    { label: 'Address all open', text: `Work through every open thread and general comment in ${tf}: fix what deserves fixing in the code, and draft replies in ${file}.` },
    { label: 'Check for new comments', before: () => loadFeedback('gh'), text: `Reviewers may have added comments. Re-read ${tf} and handle anything new the same way: fix in code where warranted, and draft replies in ${file}.` },
    { label: 'Draft replies only', text: `Draft replies in ${file} for the open threads without changing code yet.` },
  ], { wrap: (v) => `${v} (Threads: ${tf}; drafts: ${file})` }));
}
