// Token usage and cost from Claude Code transcripts in ~/.claude/projects and Pi sessions under SR_HOME.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const CH = process.env.SR_HOME || path.join(os.homedir(), '.situation-room');
const PI_ROOT = path.join(CH, 'pi-sessions');
// Extra Claude config dirs signed in with a subscription login: tokens count, cost does not.
const LOGIN_ROOTS = (process.env.SR_LOGIN_DIRS || '').split(':').filter(Boolean).map((d) => path.join(d, 'projects'));
const harnessOf = (file) => (file.startsWith(PI_ROOT) ? 'pi' : LOGIN_ROOTS.some((r) => file.startsWith(r)) ? 'login' : 'claude');
const files_ = (since) => LOGIN_ROOTS.reduce((out, r) => walk(r, out, since), walk(PI_ROOT, walk(ROOT, [], since), since));
const GW = path.join(CH, 'prices.json');

// $ per million tokens; cache writes are 1.25x (5m) / 2x (1h) input.
const PRICES = [
  [/fable-5-1|mythos-5-1/, { in: 10, out: 50, read: 0.25 }],
  [/fable|mythos/, { in: 10, out: 50, read: 1 }],
  [/opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/opus/, { in: 5, out: 25, read: 0.5 }],
  [/sonnet-5/, { in: 2, out: 10, read: 0.2 }],
  [/sonnet/, { in: 3, out: 15, read: 0.3 }],
  [/haiku/, { in: 1, out: 5, read: 0.1 }],
];

const files = new Map(); // path -> { offset, rest, msgs: Map<msgId, row> }

// Gateway prices cached by the daemon win over the list prices above.
let gw = {}, gwAt = 0;
function priceFor(model) {
  try { const t = fs.statSync(GW).mtimeMs; if (t !== gwAt) { gw = JSON.parse(fs.readFileSync(GW, 'utf8')); gwAt = t; } } catch {}
  const g = gw[model];
  if (g) return { in: g[0], out: g[1], read: g[2] ?? g[0] * 0.1, w5: g[3] ?? g[0] * 1.25, w1: g[4] ?? g[0] * 2 };
  for (const [re, p] of PRICES) if (re.test(model)) return { ...p, w5: p.in * 1.25, w1: p.in * 2 };
  return null;
}

function cost(model, u) {
  const p = priceFor(model);
  if (!p) return 0;
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0;
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out
    + w5 * p.w5 + w1 * p.w1 + (u.cache_read_input_tokens || 0) * p.read) / 1e6;
}

// Reads only what was appended since the last scan.
function ingest(file) {
  let st;
  try { st = fs.statSync(file); } catch { return files.delete(file); }
  let f = files.get(file);
  if (!f || st.size < f.offset) files.set(file, (f = { offset: 0, rest: '', msgs: new Map() }));
  if (st.size === f.offset) return f;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - f.offset);
  fs.readSync(fd, buf, 0, buf.length, f.offset);
  fs.closeSync(fd);
  f.offset = st.size;
  const lines = (f.rest + buf.toString('utf8')).split('\n');
  f.rest = lines.pop();
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant') { piRow(f, e); continue; }
    const m = e.message;
    if (e.type !== 'assistant' || !m?.usage || !m.id || m.model === '<synthetic>') continue;
    const u = m.usage;
    f.msgs.set(m.id, {
      ts: Date.parse(e.timestamp) || 0,
      model: m.model,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cost: cost(m.model, u),
    });
  }
  return f;
}

function piRow(f, e) {
  const u = e.type === 'message' ? e.message?.role === 'assistant' && e.message.usage : e.usage;
  if (!u || !e.id) return;
  f.msgs.set(e.id, {
    ts: e.message?.timestamp || Date.parse(e.timestamp) || 0,
    model: e.type === 'message' ? e.message.model : null,
    input: u.input || 0, output: u.output || 0, cacheWrite: u.cacheWrite || 0, cacheRead: u.cacheRead || 0,
    cost: u.cost?.total || 0,
  });
}

// Repriced at read time so a gateway price change applies to past Pi calls too.
function piCost(r) {
  const p = r.model && priceFor(r.model);
  return p ? (r.input * p.in + r.output * p.out + r.cacheRead * p.read + r.cacheWrite * p.w5) / 1e6 : r.cost;
}

function walk(dir, out, since) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out, since);
    else if (d.name.endsWith('.jsonl')) {
      try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch {}
    }
  }
  return out;
}

const blank = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, turns: 0 });
function add(acc, r) {
  acc.input += r.input; acc.output += r.output; acc.cacheWrite += r.cacheWrite; acc.cacheRead += r.cacheRead;
  acc.cost += r.cost; acc.turns += 1;
}

function sessionOf(file) {
  const m = file.match(/[/_]([0-9a-f-]{36})(?:\.jsonl|\/subagents\/)/);
  return m?.[1];
}

function summary(sessionIds = []) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const month = blank();
  const by = { claude: blank(), pi: blank(), login: blank() };
  const sessions = Object.fromEntries(sessionIds.map((id) => [id, { ...blank(), context: 0, model: null, last: 0 }]));
  const counted = new Set();
  for (const file of files_(monthStart)) {
    const f = ingest(file);
    if (!f) continue;
    const sid = sessionOf(file);
    const s = sessions[sid];
    const isMain = file.endsWith(`${sid}.jsonl`);
    const harness = harnessOf(file);
    const pi = harness === 'pi';
    const h = by[harness];
    for (const [id, row] of f.msgs) {
      const r = pi ? { ...row, cost: piCost(row) } : harness === 'login' ? { ...row, cost: 0 } : row;
      // Forks and resumes copy history into a new transcript; count each message once.
      if (r.ts >= monthStart && !counted.has(id)) { counted.add(id); add(month, r); add(h, r); }
      if (!s || counted.has(`${sid}|${id}`)) continue;
      counted.add(`${sid}|${id}`);
      add(s, r);
      // Context size is the main thread's latest prompt, not a subagent's.
      if (isMain && r.model && r.ts >= s.last) { s.last = r.ts; s.model = r.model; s.context = r.input + r.cacheWrite + r.cacheRead; }
    }
  }
  return { month, by, sessions, monthLabel: now.toLocaleString('en', { month: 'long' }) };
}

// Raw transcript model names mapped to catalog ids, so one model groups across harnesses.
const CATALOG = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf8')); } catch { return []; } })();
const idOf = (raw) => CATALOG.find((m) => m.id === raw || m.base === raw || m.gw === raw || m.gw?.endsWith(`/${raw}`))?.id || raw;
const dayOf = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// Breakdown by model and harness for the last `days` days (0 = this month); `ref` reprices everything for comparison.
function detail({ days = 0, ref } = {}) {
  const now = new Date();
  const since = days ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime() : new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const rp = ref && priceFor(ref);
  const refCost = (r) => (rp ? (r.input * rp.in + r.output * rp.out + r.cacheRead * rp.read + r.cacheWrite * rp.w5) / 1e6 : 0);
  const rows = new Map(), daily = new Map(), sess = new Map(), counted = new Set();
  for (let t = since; t <= now.getTime(); t += 864e5) daily.set(dayOf(t), {});
  for (const file of files_(since)) {
    const f = ingest(file);
    if (!f) continue;
    const harness = harnessOf(file);
    const pi = harness === 'pi';
    const sid = sessionOf(file);
    let model = null;
    for (const [id, row] of [...f.msgs].sort((a, b) => a[1].ts - b[1].ts)) {
      // Pi usage/compaction entries carry no model; they belong to the model in use.
      if (row.model) model = idOf(row.model);
      if (row.ts < since || !model || counted.has(id)) continue;
      counted.add(id);
      const r = pi ? { ...row, cost: piCost(row) } : harness === 'login' ? { ...row, cost: 0 } : row;
      const key = `${harness}|${model}`;
      const g = rows.get(key) || rows.set(key, { harness, model, ...blank(), ref: 0 }).get(key);
      add(g, r);
      // The reference model's own rows keep their real cost, which already splits 5m/1h cache writes.
      // Login rows have no real cost, so the what-if always reprices them.
      g.ref += model === ref && harness !== 'login' ? r.cost : refCost(r);
      const d = daily.get(dayOf(r.ts));
      if (d) { const c = (d[model] ||= { cost: 0, tokens: 0 }); c.cost += r.cost; c.tokens += r.input + r.output + r.cacheRead + r.cacheWrite; }
      const s = sess.get(sid) || sess.set(sid, { id: sid, harness, ...blank() }).get(sid);
      add(s, r);
      s.model = model;
    }
  }
  return { since, rows: [...rows.values()], daily: [...daily].map(([day, m]) => ({ day, m })), sessions: [...sess.values()] };
}

module.exports = { summary, detail };
