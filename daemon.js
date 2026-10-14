// Owns every pty so the UI can reload or crash without killing sessions.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.SR_PORT || 7777);
const HOME = process.env.SR_HOME || path.join(os.homedir(), '.situation-room');
const STATE = path.join(HOME, 'state.json');
const CONFIG = path.join(HOME, 'config.json');
const SCROLLBACK = 400_000;
// Replay trims old output, so input modes (bracketed paste, focus, mouse) are tracked and re-sent on attach.
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g;
const INPUT_MODES = new Set(['1000', '1002', '1003', '1004', '1006', '2004']);
const REVIEWS = path.join(HOME, 'reviews');
const NOTES = path.join(HOME, 'notes');
const PI_DIR = path.join(HOME, 'pi-agent');
const PI_SESSIONS = path.join(HOME, 'pi-sessions');
let MODELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf8'));
const piFile = (t) => { try { const f = fs.readdirSync(PI_SESSIONS).find((n) => n.endsWith(`_${t.sessionId}.jsonl`)); return f && path.join(PI_SESSIONS, f); } catch {} };
const modelOf = (id) => MODELS.find((m) => m.id === id);
const PRICES = path.join(HOME, 'prices.json');
for (const d of ['worktrees', 'reviews', 'notes', 'pi-agent', 'pi-sessions']) fs.mkdirSync(path.join(HOME, d), { recursive: true });
// Pi gets the same global instructions as Claude Code.
try { fs.symlinkSync(path.join(os.homedir(), '.claude/CLAUDE.md'), path.join(PI_DIR, 'CLAUDE.md')); } catch {}

function readJson(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
}
const expand = (p) => path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
// Defaults; ~/.situation-room/config.json overrides them (see config.example.json).
const raw = readJson(CONFIG, {});
const config = {
  roots: [path.join(os.homedir(), 'code')],
  org: '',
  prRepos: [],
  spaces: { personal: { label: 'Personal', roots: ['~/personal'], claudeConfigDir: '~/.claude-personal' } },
  ...raw,
  pi: { mode: 'native', ...raw.pi },
  // Jira is off until a site is configured. team: projects where For me lists every open ticket.
  jira: raw.jira?.base ? { envFile: path.join(__dirname, '.env'), defaultProject: '', repos: {}, team: [], ...raw.jira } : null,
};
config.roots = config.roots.map((r) => expand(r));
for (const sp of Object.values(config.spaces || {})) { sp.roots = (sp.roots || []).map((r) => expand(r)); if (sp.claudeConfigDir) sp.claudeConfigDir = expand(sp.claudeConfigDir); }
// A gateway (LiteLLM or similar) brings its own model catalog, used by both harnesses.
if (config.gateway?.url) {
  // A relative path is read from the data folder, beside config.json.
  const f = config.gateway.models && (path.isAbsolute(config.gateway.models.replace(/^~/, '/')) ? expand(config.gateway.models) : path.join(HOME, config.gateway.models));
  const list = f && readJson(f, null);
  if (Array.isArray(list)) MODELS = list; else console.error(`gateway: no model list at ${f}; using models.json`);
}
const gatewayOn = () => !!config.gateway?.url;

// Spaces: tasks tagged with a space show only in that space. A space with claudeConfigDir runs Claude Code on that
// dir's own /login, never the gateway; its tasks get no Pi and use Anthropic's model names.
const spaceOf = (t) => (t?.space && config.spaces?.[t.space]) || null;
const loginDir = (t) => spaceOf(t)?.claudeConfigDir || null;
for (const sp of Object.values(config.spaces || {})) {
  if (!sp.claudeConfigDir) continue;
  fs.mkdirSync(path.join(sp.claudeConfigDir, 'projects'), { recursive: true });
  const st = path.join(sp.claudeConfigDir, 'settings.json');
  if (!fs.existsSync(st)) fs.writeFileSync(st, '{}\n');
  try { fs.symlinkSync(path.join(os.homedir(), '.claude', 'CLAUDE.md'), path.join(sp.claudeConfigDir, 'CLAUDE.md')); } catch {}
}
const state = readJson(STATE, { tasks: [] });
const procs = new Map(); // `${id}:${kind}` -> { pty, buf }
const clients = new Set();

// Writes back only what the user set, plus the PR repo list the UI edits.
function saveConfig() { fs.writeFileSync(CONFIG, JSON.stringify({ ...raw, prRepos: config.prRepos }, null, 2)); }
function save() { fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); }
function task(id) { return state.tasks.find((t) => t.id === id); }
const kindOf = (t) => t.kind || (t.pr ? 'review' : 'task');
function writeJson(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2)); }
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}
function publish() { broadcast({ t: 'tasks', tasks: state.tasks }); }
function setStatus(t, status) {
  if (t.status === status) return;
  t.status = status;
  t.updatedAt = Date.now();
  save();
  publish();
}

if (!task('builder')) {
  state.tasks.unshift({
    id: 'builder', name: 'Builder', repo: 'situation-room', cwd: __dirname,
    sessionId: crypto.randomUUID(), started: false, status: 'idle', pinned: true,
  });
  save();
}
// config.builderSpace puts the Builder in that space; with allowMain there, it ships straight to main.
{
  const b = task('builder');
  const sp = config.builderSpace && config.spaces?.[config.builderSpace] ? config.builderSpace : null;
  if ((b.space || null) !== sp) {
    if (sp) b.space = sp; else delete b.space;
    if (sp && config.spaces[sp].allowMain) b.onMain = true; else delete b.onMain;
    save();
  }
}
// A repo with no commits yet has no HEAD to diff or ship against, so it counts as plain folder.
const isGit = (cwd) => { try { return execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' }), true; } catch { return false; } };
// Optional per-repo debug settings (namespace, notes, index), matched by repo folder name or path.
function debugSettings(repoPath) {
  const name = path.basename(repoPath || '');
  return Object.values(config.debug || {}).find((d) => d.repo && (d.repo === name || expand(d.repo) === repoPath)) || {};
}

// Claude keys transcripts by cwd, so a session that changes directory needs its transcript copied over.
// The Claude config dir a task runs under; an add-on may give some tasks their own.
const claudeDir = (t) => loginDir(t) || path.join(os.homedir(), '.claude');
const projectDir = (cwd, t) => path.join(claudeDir(t), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
function moveSession(t, cwd) {
  if (t.harness === 'pi') return movePiSession(t, cwd);
  const from = path.join(projectDir(t.cwd, t), `${t.sessionId}.jsonl`);
  const to = path.join(projectDir(cwd, t), `${t.sessionId}.jsonl`);
  if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
  t.cwd = cwd;
}
// Pi resumes by file from anywhere, but asks when the recorded cwd is gone.
function movePiSession(t, cwd) {
  const f = piFile(t);
  if (f) {
    const [head, ...rest] = fs.readFileSync(f, 'utf8').split('\n');
    fs.writeFileSync(f, [JSON.stringify({ ...JSON.parse(head), cwd }), ...rest].join('\n'));
  }
  t.cwd = cwd;
}
// Sessions from a previous daemon are gone; their state is stale.
for (const t of state.tasks) {
  if (t.status === 'working') t.status = 'idle';
  // A deleted worktree falls back to the main checkout and whatever branch it is on.
  if (t.repoPath && !fs.existsSync(t.cwd) && fs.existsSync(t.repoPath)) {
    moveSession(t, t.repoPath);
    try { t.branch = execFileSync('git', ['-C', t.cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim() || null; } catch {}
    t.status = 'idle';
  }
  if (t.kind !== 'review' && t.kind !== 'address') t.git = isGit(t.cwd);
}

const hookCmd = (ev) =>
  `curl -s -m 2 -X POST --data-binary @- http://127.0.0.1:${PORT}/hook/$SR_TASK/${ev} >/dev/null 2>&1 || true`;
const hookSettings = JSON.stringify({
  hooks: Object.fromEntries(
    [['UserPromptSubmit', 'working'], ['PreToolUse', 'working'], ['PostToolUse', 'working'], ['Notification', 'notify'], ['Stop', 'done']]
      .map(([ev, name]) => [ev, [{ hooks: [{ type: 'command', command: hookCmd(name) }] }]]),
  ),
});

// PR agents read freely and write only their drafts (and, when fixing, their own checkout).
const READ_CMDS = ['gh pr view', 'gh pr diff', 'gh pr checks', 'git log', 'git diff', 'git show', 'git status', 'ls', 'wc'];
function allowFor(t) {
  if (!t.reviewFile) return '';
  const own = kindOf(t) === 'address' || t.contribute ? [`Edit(/${t.cwd}/**)`, `Write(/${t.cwd}/**)`] : [];
  return ['Read', 'Grep', 'Glob', `Write(/${REVIEWS}/**)`, `Edit(/${REVIEWS}/**)`, ...own, ...READ_CMDS.map((c) => `Bash(${c}:*)`)].join(',');
}

// Gateway url and key. keyFrom "claude-settings" reuses Claude Code's ANTHROPIC_AUTH_TOKEN; "env:NAME" reads a variable.
function gateway() {
  const g = config.gateway || {};
  const from = g.keyFrom || 'claude-settings';
  const key = from === 'claude-settings' ? claudeSettingsEnv().ANTHROPIC_AUTH_TOKEN
    : from.startsWith('env:') ? process.env[from.slice(4)] : '';
  return { url: g.url, key: key || '' };
}

const claudeSettingsEnv = () => readJson(path.join(os.homedir(), '.claude/settings.json'), {}).env || {};
function piEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const [k, v] of Object.entries(claudeSettingsEnv())) if (/^ANTHROPIC_/.test(k) && env[k] === v) delete env[k];
  return env;
}
// Native Pi: the models Pi can reach with its own logins and keys, cached for a minute.
let piModels = { at: 0, list: [] };
function nativePiModels() {
  if (Date.now() - piModels.at < 60_000) return piModels.list;
  let out = '';
  try {
    out = execFileSync(path.join(__dirname, 'node_modules/.bin/pi'), ['--list-models'], {
      encoding: 'utf8', timeout: 20_000, env: piEnv({ PI_CODING_AGENT_DIR: PI_DIR, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }), stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) { out = e.stdout || ''; }
  const size = (v) => (/M$/.test(v) ? parseFloat(v) * 1e6 : /K$/.test(v) ? parseFloat(v) * 1e3 : Number(v) || 0);
  const list = out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4)
    .map(([prov, id, ctx, out]) => ({ id: `${prov}/${id}`, label: `${id} · ${prov}`, ctx: size(ctx), out: size(out), cost: [0, 0, 0, 0], pi: true }));
  piModels = { at: Date.now(), list };
  return list;
}

// Gateway prices ($/1M: in, out, cache read, cache write 5m, 1h) cached for usage.js and the Pi extension.
async function refreshPrices() {
  if (!gatewayOn()) return;
  const gw = gateway();
  try {
    const r = await fetch(`${gw.url}/model/info`, { headers: { Authorization: `Bearer ${gw.key}` }, signal: AbortSignal.timeout(20_000) });
    const info = new Map((await r.json()).data.map((d) => [d.litellm_params?.model, d.model_info || {}]));
    const per = (v) => (v == null ? null : +(v * 1e6).toFixed(6));
    const prices = {};
    for (const m of MODELS) {
      const i = info.get(m.gw);
      if (!i || i.input_cost_per_token == null) continue;
      prices[m.id] = [i.input_cost_per_token, i.output_cost_per_token, i.cache_read_input_token_cost, i.cache_creation_input_token_cost, i.cache_creation_input_token_cost_above_1hr].map(per);
      if (m.base) prices[m.base] = prices[m.id];
      m.cost = prices[m.id].slice(0, 4).map((v, k) => v ?? m.cost[k]);
    }
    fs.writeFileSync(PRICES, JSON.stringify(prices, null, 2));
  } catch (e) { console.error('prices', e.message); }
}

function piArgs(t, env) {
  const gw = gatewayOn() ? gateway() : null;
  const own = kindOf(t) === 'address' || t.contribute ? [t.cwd] : [];
  // Gateway models are registered as provider "gateway"; native ids already carry their provider.
  const model = t.model || config.pi.model || (gw ? MODELS[0].id : '');
  // Native Pi must not pick up a gateway's ANTHROPIC_* from Claude Code's settings and send it to Anthropic.
  if (!gw) for (const k of Object.keys(claudeSettingsEnv())) if (/^ANTHROPIC_/.test(k) && env[k] === claudeSettingsEnv()[k]) delete env[k];
  Object.assign(env, {
    PI_CODING_AGENT_DIR: PI_DIR, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', SR_PORT: String(PORT),
    SR_GATEWAY_URL: gw?.url || '', SR_GATEWAY_KEY: gw?.key || '', SR_MODELS: gw ? (path.isAbsolute(config.gateway.models.replace(/^~/, '/')) ? expand(config.gateway.models) : path.join(HOME, config.gateway.models)) : '', SR_PRICES: PRICES, SR_MODEL: gw && model ? `gateway/${model}` : model,
    SR_SESSION: piFile(t) || '', SR_FORK: (t.forkFrom && piFile({ sessionId: t.forkFrom })) || t.forkFrom || '', SR_EFFORT: t.effort || '',
    SR_GATE: t.reviewFile ? JSON.stringify({ write: [REVIEWS, NOTES, ...own], bash: READ_CMDS }) : '',
  });
  // An existing file resumes from any cwd; otherwise the exact id is created, forked from the source when asked.
  const sess = env.SR_SESSION ? '--session "$SR_SESSION"' : `${t.forkFrom ? '--fork "$SR_FORK" ' : ''}--session-id ${t.sessionId}`;
  const skills = [path.join(os.homedir(), '.claude/skills'), path.join(t.cwd, '.claude/skills')].filter((d) => fs.existsSync(d));
  const ext = [...(gw ? ['gateway.js'] : []), 'situation-room.js'].map((f) => `-e '${path.join(__dirname, 'pi', f)}'`);
  return [`'${path.join(__dirname, 'node_modules/.bin/pi')}'`, sess, `--session-dir '${PI_SESSIONS}'`, model ? '--model "$SR_MODEL"' : '',
    t.effort ? '--thinking "$SR_EFFORT"' : '', ...ext, ...skills.map((d) => `--skill '${d}'`), '-n "$SR_NAME"',
    env.SR_PROMPT_FILE ? '--append-system-prompt "$SR_PROMPT_FILE"' : ''].filter(Boolean).join(' ');
}

// Gateway variables must be absent for a login dir, not blank: blank ones break the login.
const claudeEnv = (t) => (loginDir(t) ? { CLAUDE_CONFIG_DIR: loginDir(t), ANTHROPIC_BASE_URL: null, ANTHROPIC_AUTH_TOKEN: null, ANTHROPIC_MODEL: null } : {});

const noteFile = (t) => path.join(NOTES, `${t.id}.md`);
// Every task gets prompts/task.md; debug tasks add prompts/debug.md and the repo's notes from config.debug.
function taskPrompt(t) {
  let text = fs.readFileSync(path.join(__dirname, 'prompts', 'task.md'), 'utf8').replaceAll('{{note}}', noteFile(t));
  if (kindOf(t) === 'debug') {
    const d = debugSettings(t.repoPath);
    text += `\n\n${fs.readFileSync(path.join(__dirname, 'prompts', 'debug.md'), 'utf8')}`;
    const notes = d.notes && expand(path.isAbsolute(d.notes.replace(/^~/, '/')) ? d.notes : path.join(t.cwd, d.notes));
    if (notes && fs.existsSync(notes)) text += `\n\n# About this project\n\n${fs.readFileSync(notes, 'utf8')}`;
    if (d.namespace) text += `\n\nLogs: this project runs in Kubernetes namespace \`${d.namespace}\`; sr-logs uses it by default.`;
  }
  const f = path.join(HOME, 'prompts', `${t.id}.md`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
// Log credentials live in .env beside the app (SR_LOGS_URL, SR_LOGS_API_KEY); the tools folder goes on PATH.
function debugEnv(t) {
  if (kindOf(t) !== 'debug') return {};
  const env = {};
  try {
    for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = l.match(/^(SR_LOGS_[A-Z_]+)=["']?(.*?)["']?\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  const d = debugSettings(t.repoPath);
  if (d.namespace) env.SR_LOGS_NAMESPACE = d.namespace;
  if (d.index) env.SR_LOGS_INDEX = d.index;
  if (config.logs?.url && !env.SR_LOGS_URL) env.SR_LOGS_URL = config.logs.url;
  env.PATH = `${path.join(__dirname, 'tools')}:${process.env.PATH}`;
  return env;
}
// Gateway ids map to Anthropic's own names for a login dir.
const claudeModelId = (t) => (loginDir(t) && modelOf(t.model)?.base) || t.model;
function cleanEnv(extra) {
  const env = { ...process.env, TERM: 'xterm-256color', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  // A null in extra removes that variable instead of setting it.
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  // Inherited parent-session markers turn off transcripts, which breaks --resume.
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|CLAUDE_EFFORT)/.test(k)) delete env[k];
  return env;
}

function spawn(t, kind, cols = 120, rows = 40) {
  const key = `${t.id}:${kind}`;
  if (procs.has(key)) return procs.get(key);
  const first = !t.started && t.prompt ? t.prompt : t.pending || '';
  const env = cleanEnv({ SR_TASK: t.id, SR_NAME: t.name, SR_PROMPT: first, SR_ALLOW: allowFor(t), ...claudeEnv(t), ...debugEnv(t) });
  if (kind === 'claude') env.SR_PROMPT_FILE = taskPrompt(t);
  if (t.pending) { delete t.pending; save(); }
  let file, args;
  if (kind === 'claude' && t.harness === 'pi') {
    file = process.env.SHELL || '/bin/zsh';
    args = ['-lc', `exec ${piArgs(t, env)}${first ? ' -- "$SR_PROMPT"' : ''}`];
  } else if (kind === 'claude') {
    // --resume only works once the session has a transcript on disk.
    const sess = t.started ? ['--resume', t.sessionId] : ['--session-id', t.sessionId];
    // Fork tasks copy a live session fresh on every launch instead of sharing its transcript.
    if (t.fork) sess.push('--fork-session');
    sess.push(`--add-dir=${NOTES}`);
    if (t.reviewFile) sess.push(`--add-dir=${REVIEWS}`, '--allowedTools="$SR_ALLOW"');
    // A task that adopted PR feedback writes its reply drafts there too.
    else if (t.fb) sess.push(`--add-dir=${REVIEWS}`);
    // Gateways cap context at 200k without the [1m] suffix; Anthropic's own models need none.
    if (modelOf(t.model)) { env.SR_MODEL = claudeModelId(t) + (gatewayOn() && !loginDir(t) && modelOf(t.model).ctx >= 1e6 ? '[1m]' : ''); sess.push('--model "$SR_MODEL"'); }
    if (t.effort) { env.SR_EFFORT = t.effort; sess.push('--effort "$SR_EFFORT"'); }
    if (env.SR_PROMPT_FILE) sess.push('--append-system-prompt "$(cat "$SR_PROMPT_FILE")"');
    // Kickoff prompt on first launch, or a queued follow-up on relaunch.
    const prompt = first ? ' -- "$SR_PROMPT"' : '';
    file = process.env.SHELL || '/bin/zsh';
    args = ['-lc', `exec claude ${sess.join(' ')} --name "$SR_NAME" --settings '${hookSettings}'${prompt}`];
  } else {
    file = process.env.SHELL || '/bin/zsh';
    args = ['-l'];
  }
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: t.cwd, env });
  const entry = { pty: p, buf: '', modes: new Set() };
  procs.set(key, entry);
  p.onData((d) => {
    for (const [, ns, on] of d.matchAll(MODE_RE)) for (const n of ns.split(';')) if (INPUT_MODES.has(n)) entry.modes[on === 'h' ? 'add' : 'delete'](n);
    entry.buf = (entry.buf + d).slice(-SCROLLBACK);
    broadcast({ t: 'out', id: t.id, kind, data: d });
  });
  p.onExit(() => {
    procs.delete(key);
    broadcast({ t: 'exit', id: t.id, kind });
    if (kind === 'claude' && task(t.id)) setStatus(t, 'stopped');
  });
  return entry;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function listRepos(roots = config.roots) {
  const out = [];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const p = path.join(root, n);
      // A .git file means a worktree, not a repo of its own.
      if (fs.statSync(path.join(p, '.git'), { throwIfNoEntry: false })?.isDirectory()) out.push({ name: n, path: p });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// In a space a bare name resolves under its roots and is never cloned from the work org.
function spacePath(input, sp) {
  const p = /^[~/]/.test(input) ? expand(input) : listRepos(sp.roots).find((r) => r.name === input)?.path || path.join(sp.roots[0] || os.homedir(), input);
  if (!fs.existsSync(p)) throw new Error(`no such directory: ${p}`);
  return p;
}
// The main repo a linked worktree belongs to, or null for a main checkout or a non-git folder.
function mainRepoOf(dir) {
  try {
    const own = git(dir, 'rev-parse', '--path-format=absolute', '--git-dir');
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    return own !== common ? path.dirname(common) : null;
  } catch { return null; }
}
// Accepts a path, a repo name under config.roots, or owner/name; clones with gh when missing.
function ensureRepo(input) {
  const p = expand(input);
  if (/^[~/]/.test(input)) { if (!fs.existsSync(p)) throw new Error(`no such directory: ${p}`); return p; }
  const name = input.split('/').pop();
  const found = listRepos().find((r) => r.name === name);
  if (found) return found.path;
  const dest = path.join(config.roots[0], name);
  gh(['repo', 'clone', input.includes('/') ? input : `${config.org}/${name}`, dest]);
  return dest;
}

// Ignored local files a fresh worktree needs: env, keys, local settings. Never node_modules or build output.
const LOCAL_FILE = /(^|\/)(\.env(\.[\w-]+)?|\.envrc|\.npmrc|[^/]+\.pem|\.claude\/settings\.local\.json)$/;
function copyLocalFiles(from, to) {
  let files = [];
  try { files = git(from, 'ls-files', '-oi', '--exclude-standard', '--directory').split('\n'); } catch {}
  const copied = [];
  for (const f of files.filter((x) => LOCAL_FILE.test(x) && !x.includes('node_modules/'))) {
    const dest = path.join(to, f);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, f), dest);
    copied.push(f);
  }
  return copied;
}

const STOP = new Set('a an the to of for in on and or with from by is be it this that as at into when why how what make add use should can'.split(' '));
function fallbackBranch(name, key) {
  const words = name.toLowerCase().replace(key ? key.toLowerCase() : '', '').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).slice(0, 3);
  return [key?.toLowerCase(), ...words].filter(Boolean).join('-') || 'task';
}

// Short branch name in the repo's own style; never mentions Situation Room.
async function branchName(repoPath, name, key, t) {
  let recent = [];
  try { recent = git(repoPath, 'for-each-ref', '--sort=-committerdate', '--count=25', '--format=%(refname:lstrip=3)', 'refs/remotes/origin').split('\n').filter((b) => b && b !== 'HEAD'); } catch {}
  let b = '';
  try {
    const r = await Promise.race([
      claudeJson(`Suggest a git branch name for this work: "${name}".
Recent branches in the repo, follow their style:
${recent.join('\n')}
Rules: lowercase kebab-case, at most four words${key ? `, starting with "${key.toLowerCase()}-"` : ''}, short and plain. Never use the words situation or room.
Reply with JSON only: {"branch": string}`, t),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45_000)),
    ]);
    b = String(r.branch || '');
  } catch {}
  b = b.toLowerCase().replace(/situation-room|cockpit/g, '').replace(/[^a-z0-9/-]+/g, '-').replace(/-+/g, '-').replace(/^[-/]+|[-/]+$/g, '').slice(0, 50);
  if (!b || (key && !b.startsWith(key.toLowerCase()))) b = fallbackBranch(name, key);
  let out = b;
  for (let n = 2; ; n++) {
    try { git(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${out}`); } catch { return out; }
    out = `${b}-${n}`;
  }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Harness, model and effort a task launches with; unknown values fall back to the defaults.
function agentOf({ harness, model, effort } = {}, scope) {
  const pi = harness === 'pi' && !loginDir(scope);
  // Native Pi ids are provider/model and are passed through; everything else must be in the catalog.
  const ok = pi ? (gatewayOn() ? !!modelOf(model) : /^[\w.-]+\/[\w.:-]+$/.test(String(model || ''))) : !!modelOf(model)?.claude;
  return { harness: pi ? 'pi' : 'claude', model: ok ? model : undefined, effort: EFFORTS.includes(effort) ? effort : undefined };
}

const claudeTranscript = (id, t) => {
  const root = path.join(claudeDir(t), 'projects');
  try { for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${id}.jsonl`); if (fs.existsSync(f)) return f; } } catch {}
};
// Finds the session to resume; throws before any branch or worktree is made.
function sessionSource(resumeId, harness, fork, t) {
  const id = String(resumeId || '').trim();
  if (!id) return null;
  const pi = harness === 'pi';
  // A resume may come from the other config dir; the transcript is copied across.
  const file = pi ? piFile({ sessionId: id }) : claudeTranscript(id, t) || claudeTranscript(id);
  if (!file) {
    const other = pi ? claudeTranscript(id) && 'Claude Code' : piFile({ sessionId: id }) && 'Pi';
    throw new Error(other ? `${id} is a ${other} session; pick that harness.` : `No ${pi ? 'Pi' : 'Claude Code'} session ${id}.`);
  }
  const live = state.tasks.find((x) => x.sessionId === id && procs.has(`${x.id}:claude`));
  if (live && !fork) throw new Error(`"${live.name}" is running this session; close that task or tick Fork.`);
  return { id, file };
}
// Claude resumes by id from the task's own project dir, so the transcript is copied there.
function resumeFields(src, fork, harness, cwd, t) {
  if (!src) return { sessionId: crypto.randomUUID(), started: false };
  if (harness === 'pi') return fork ? { sessionId: crypto.randomUUID(), started: false, forkFrom: src.id } : { sessionId: src.id, started: true };
  const to = path.join(projectDir(cwd, t), `${src.id}.jsonl`);
  if (!fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(src.file, to); }
  return { sessionId: src.id, started: true, fork: !!fork };
}
// A resumed session gets the kickoff prompt as its next message.
const kickoff = (t) => { if (t.started && t.prompt) t.pending = t.prompt; return t; };

// New work branches off fresh origin/main in the repo's own checkout; a worktree beside it when asked, or when the checkout is dirty or in use.
async function createTask({ name, repoPath, worktree, resumeId, fork, extra, space, debug, report, onMain, ...choice }) {
  const scope = config.spaces?.[space] ? { space } : {};
  if (onMain && !config.spaces?.[space]?.allowMain) throw new Error('Working on main is only allowed in a space with allowMain.');
  if (onMain && (debug || extra?.kind)) throw new Error('Working on main is only for plain tasks.');
  // A debug task works on any repo; it always gets a fresh worktree off the default branch.
  if (debug) {
    worktree = true;
    resumeId = undefined;
    extra = { ...extra, kind: 'debug', debug: true,
      prompt: `${String(report || '').trim() || 'Wait for the report.'}\n\nThis is a fresh worktree off origin/main with no installed dependencies.` };
  }
  const agent = agentOf(choice, scope);
  const src = sessionSource(resumeId, agent.harness, fork, scope);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const id = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
  repoPath = spaceOf(scope) ? spacePath(repoPath, spaceOf(scope)) : ensureRepo(repoPath);
  if (debug) extra.label = `Debug · ${path.basename(repoPath)}`;
  let cwd = repoPath;
  let branch = null;
  // A worktree picked as the folder is used as it is, on its branch; its main repo is recorded as repoPath.
  const linked = !debug && extra?.kind !== 'jira' && mainRepoOf(repoPath);
  if (linked) {
    cwd = repoPath;
    repoPath = linked;
    try { branch = git(cwd, 'branch', '--show-current') || null; } catch {}
  }
  // On main: the repo's own checkout, switched to the default branch and fast-forwarded; no new branch.
  if (onMain && !linked) {
    if (!isGit(repoPath)) throw new Error(`not a git repo: ${repoPath}`);
    if (git(repoPath, 'status', '--porcelain')) throw new Error(`${path.basename(repoPath)} has uncommitted changes; commit or stash them first.`);
    if (state.tasks.some((x) => x.cwd === repoPath && procs.has(`${x.id}:claude`))) throw new Error(`another task is running in ${path.basename(repoPath)}.`);
    const base = baseRef(repoPath).replace(/^origin\//, '');
    try { git(repoPath, 'fetch', 'origin', base); } catch {}
    git(repoPath, 'switch', base);
    try { git(repoPath, 'merge', '--ff-only', `origin/${base}`); } catch {}
    branch = base;
    extra = { ...extra, onMain: true };
  }
  // Resuming into a plain task keeps the checkout as it is; a Jira task still gets its branch.
  if (!onMain && !linked && (!src || extra?.kind === 'jira') && isGit(repoPath)) {
    let base = 'origin/main';
    try { base = git(repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'); } catch {}
    try { git(repoPath, 'fetch', 'origin', base.replace(/^origin\//, '')); } catch {}
    // A repo with no origin branches off whatever is checked out.
    try { git(repoPath, 'rev-parse', '--verify', '--quiet', base); } catch { base = 'HEAD'; }
    worktree ||= !!git(repoPath, 'status', '--porcelain') || state.tasks.some((x) => x.cwd === repoPath && procs.has(`${x.id}:claude`));
    branch = await branchName(repoPath, name, extra?.jira?.key, scope);
    if (worktree) {
      cwd = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-${branch.replace(/\//g, '-')}`);
      git(repoPath, 'worktree', 'add', '--no-track', '-b', branch, cwd, base);
      copyLocalFiles(repoPath, cwd);
      if (extra?.prompt) extra = { ...extra, prompt: `${extra.prompt}\nThis is a fresh worktree with no installed dependencies or build output; install them before running tests.` };
    } else git(repoPath, 'switch', '--no-track', '-c', branch, base);
  }
  const t = {
    id, name, repo: path.basename(repoPath), repoPath, cwd, branch, ...scope,
    ...resumeFields(src, fork, agent.harness, cwd, scope), ...agent,
    status: 'idle', createdAt: Date.now(), git: isGit(cwd), worktree: cwd !== repoPath, ...extra,
  };
  kickoff(t);
  state.tasks.push(t);
  save();
  publish();
  return t;
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 50e6, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
}

function originSlug(p) {
  try { return git(p, 'remote', 'get-url', 'origin').match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1].toLowerCase(); } catch { return null; }
}
function localClone(slug) { return listRepos().find((r) => originSlug(r.path) === slug.toLowerCase())?.path; }

let login;
function whoami() { return (login ||= gh(['api', 'user', '-q', '.login']).trim()); }
// A repo's labels, cached for an hour; an empty list when gh can't read them.
const labelsAt = new Map();
function repoLabels(slug) {
  const hit = labelsAt.get(slug);
  if (hit && Date.now() - hit.at < 3600_000) return hit.list;
  let list = [];
  try { list = JSON.parse(gh(['label', 'list', '-R', slug, '--limit', '100', '--json', 'name,description'])); } catch {}
  labelsAt.set(slug, { at: Date.now(), list });
  return list;
}
// Labels that say what kind of change a PR is; other labels stay out of the picker.
const kindLabels = (slug) => repoLabels(slug).filter((l) => /^kpi:/i.test(l.name) || /^(bug|enhancement|feature|documentation|dependencies|security)$/i.test(l.name));

function listPrs(slug) {
  const prs = JSON.parse(gh(['pr', 'list', '-R', slug, '--limit', '100', '--json',
    'number,title,author,isDraft,updatedAt,reviewRequests,headRefName,url,reviewDecision']));
  const me = whoami().toLowerCase();
  return prs.map((p) => ({
    number: p.number, title: p.title, author: p.author.login, draft: p.isDraft, updatedAt: p.updatedAt,
    branch: p.headRefName, url: p.url, decision: p.reviewDecision,
    requested: p.reviewRequests.some((r) => r.login?.toLowerCase() === me),
    taskId: state.tasks.find((t) => kindOf(t) === 'review' && t.pr.slug === slug && t.pr.number === p.number)?.id,
  }));
}

// Comments on a PR, shaped for reading: code threads with their diff hunk, then the conversation. Cached briefly.
const prTalkAt = new Map();
function prTalk(slug, number) {
  const k = `${slug}#${number}`;
  const hit = prTalkAt.get(k);
  if (hit && Date.now() - hit.at < 30_000) return hit.data;
  const [o, n] = slug.split('/');
  const pr = JSON.parse(gh(['api', 'graphql', '-f', `query=${THREADS_Q}`, '-f', `o=${o}`, '-f', `n=${n}`, '-F', `num=${Number(number)}`])).data.repository.pullRequest;
  const who = (a) => a?.login || 'ghost';
  const data = {
    threads: pr.reviewThreads.nodes.map((th) => ({
      path: th.path, line: th.line ?? th.originalLine, side: th.diffSide, resolved: th.isResolved, outdated: th.isOutdated,
      hunk: th.comments.nodes[0]?.diffHunk || '',
      comments: th.comments.nodes.map((c) => ({ author: who(c.author), body: c.body, at: c.createdAt, url: c.url })),
    })),
    general: [
      ...pr.reviews.nodes.filter((r) => r.body.trim()).map((r) => ({ kind: 'review', state: r.state, author: who(r.author), body: r.body, at: r.submittedAt, url: r.url })),
      ...pr.comments.nodes.map((c) => ({ kind: 'comment', author: who(c.author), body: c.body, at: c.createdAt, url: c.url })),
    ].sort((a, b) => a.at.localeCompare(b.at)),
  };
  prTalkAt.set(k, { at: Date.now(), data });
  return data;
}

function prDetail(slug, number) {
  const p = JSON.parse(gh(['pr', 'view', String(number), '-R', slug, '--json',
    'number,title,author,body,isDraft,url,headRefName,baseRefName,createdAt,updatedAt,additions,deletions,changedFiles,files,labels,reviewDecision,latestReviews']));
  return {
    number: p.number, title: p.title, author: p.author.login, body: p.body, draft: p.isDraft, url: p.url,
    branch: p.headRefName, base: p.baseRefName, createdAt: p.createdAt, updatedAt: p.updatedAt, decision: p.reviewDecision,
    additions: p.additions, deletions: p.deletions, changedFiles: p.changedFiles, labels: p.labels.map((l) => l.name),
    files: p.files.map((f) => ({ path: f.path, add: f.additions, del: f.deletions })),
    reviews: p.latestReviews.map((r) => ({ author: r.author.login, state: r.state })),
  };
}

const NO_AI = 'Never mention Claude, AI, agents or any tooling, and add no sign-off.';

const reviewPrompt = (pr, file) => `Review PR #${pr.number} in ${pr.slug}: "${pr.title}" by @${pr.author}. \
The PR head is checked out in this directory. Read the description with \`gh pr view ${pr.number} -R ${pr.slug}\` \
and the diff with \`gh pr diff ${pr.number} -R ${pr.slug}\`; read surrounding code where it helps. \
Explore code with the file read and search tools, not shell; any Bash call is one plain command with no cd, pipes or chaining. \
Write your draft review as JSON to ${file} with this shape: \
{"summary": string, "event": "COMMENT"|"APPROVE"|"REQUEST_CHANGES", "comments": [{"path": string, "line": number, "start_line"?: number, "side": "RIGHT"|"LEFT", "body": string}]}. \
"line" is the line number in that file on that side (RIGHT = new version, LEFT = removed lines) and must sit inside a diff hunk. \
Comment only on things worth a reviewer's time: bugs, risks, missing cases, unclear intent. Keep each comment short and direct, \
written as the reviewer in first person. ${NO_AI} \
When the fix is clear and small, propose it instead of only naming the problem: end the body with a GitHub suggestion block \
(three backticks + "suggestion", the replacement lines, three backticks) that replaces lines start_line..line on the RIGHT side; \
set "start_line" when it spans several lines. Do this only where it genuinely helps; most comments need no suggestion. \
Reviews already posted are kept under "history" in the file; do not repeat those comments. \
Do not post anything to GitHub: the draft is reviewed, edited and submitted by a human from Situation Room. \
The file may be edited while you work, so re-read it before changing it. When done, reply here with a three-line summary.`;

// Puts a review task's worktree on the PR's own branch, tracking origin, so its changes can be pushed to the PR.
function contributeToPr(t) {
  if (kindOf(t) !== 'review') throw new Error('only a review task can contribute to a PR');
  if (t.contribute) return t;
  const p = JSON.parse(gh(['pr', 'view', String(t.pr.number), '-R', t.pr.slug, '--json', 'headRefName,headRefOid,isCrossRepository,maintainerCanModify,state']));
  if (p.state !== 'OPEN') throw new Error(`PR #${t.pr.number} is ${p.state.toLowerCase()}`);
  if (p.isCrossRepository) throw new Error(`PR #${t.pr.number} comes from a fork; push to it from the fork instead`);
  const branch = p.headRefName;
  if (git(t.cwd, 'status', '--porcelain')) throw new Error('the review worktree has uncommitted changes');
  if (worktreeFor(t.repoPath, branch)) throw new Error(`${branch} is already checked out in another folder`);
  git(t.repoPath, 'fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`);
  let local = true;
  try { git(t.repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`); } catch { local = false; }
  // A stale local copy of the branch would hide the author's latest commits, so it is reset to origin.
  if (local) git(t.cwd, 'switch', '-C', branch, `origin/${branch}`); else git(t.cwd, 'switch', '--track', '-c', branch, `origin/${branch}`);
  git(t.cwd, 'branch', `--set-upstream-to=origin/${branch}`);
  Object.assign(t, { contribute: true, branch, git: true });
  t.pr.headSha = p.headRefOid;
  save();
  publish();
  // Edit rights are fixed at launch, so the agent resumes its session with the go-ahead queued.
  t.pending = `You can now edit this checkout: it is on the PR's branch \`${branch}\`. Make the changes asked for, commit nothing, and tell me when they are ready to ship. Keep the review draft as it is unless I ask.`;
  save();
  const e = procs.get(`${t.id}:claude`);
  if (e) { e.pty.onExit(() => setTimeout(() => task(t.id) && spawn(t, 'claude'), 100)); e.pty.kill(); } else spawn(t, 'claude');
  return t;
}

function createReviewTask({ slug, number, resumeId, fork, ...choice }) {
  const existing = state.tasks.find((t) => kindOf(t) === 'review' && t.pr.slug === slug && t.pr.number === Number(number));
  if (existing) return existing;
  const agent = agentOf(choice);
  const src = sessionSource(resumeId, agent.harness, fork);
  const repoPath = localClone(slug);
  if (!repoPath) throw new Error(`no local clone of ${slug} under ${config.roots.join(', ')}`);
  const p = JSON.parse(gh(['pr', 'view', String(number), '-R', slug, '--json', 'number,title,author,headRefOid,headRefName,url']));
  const id = `pr-${p.number}-${crypto.randomBytes(2).toString('hex')}`;
  const cwd = path.join(HOME, 'worktrees', id);
  git(repoPath, 'fetch', 'origin', `pull/${p.number}/head`);
  git(repoPath, 'worktree', 'add', '--detach', cwd, 'FETCH_HEAD');
  const pr = { slug, number: p.number, title: p.title, author: p.author.login, headSha: p.headRefOid, reviewedSha: p.headRefOid, url: p.url };
  const reviewFile = path.join(REVIEWS, `${id}.json`);
  fs.writeFileSync(reviewFile, JSON.stringify({ summary: '', event: 'COMMENT', comments: [] }, null, 2));
  const t = {
    id, name: `#${p.number} ${p.title}`, repo: path.basename(repoPath), repoPath, cwd, branch: null,
    kind: 'review', label: `PR #${p.number} · ${p.headRefName} · @${pr.author}`, pr, reviewFile, prompt: reviewPrompt(pr, reviewFile),
    ...resumeFields(src, fork, agent.harness, cwd), status: 'idle', createdAt: Date.now(), ...agent,
  };
  kickoff(t);
  state.tasks.push(t);
  save();
  publish();
  return t;
}

const diffs = new Map(); // `${slug}#${number}@${sha}` -> diff text
function prDiff(t) {
  const key = `${t.pr.slug}#${t.pr.number}@${t.pr.headSha}`;
  if (!diffs.has(key)) diffs.set(key, gh(['pr', 'diff', String(t.pr.number), '-R', t.pr.slug]));
  return diffs.get(key);
}

function readReview(t) {
  const d = readJson(t.reviewFile, { summary: '', event: 'COMMENT', comments: [] });
  // Older drafts kept the posted comments in place after submit.
  if (d.submitted) {
    d.history = [...(d.history || []), { ...d.submitted, event: d.event, body: d.summary, comments: d.comments }];
    Object.assign(d, { summary: '', event: 'COMMENT', comments: [] });
    delete d.submitted;
    writeJson(t.reviewFile, d);
  }
  return d;
}

const busy = new Set(); // guards against double-posting while a gh call is in flight
function once(key, fn) {
  if (busy.has(key)) throw new Error('already in progress');
  busy.add(key);
  try { return fn(); } finally { busy.delete(key); }
}

function submitReview(t, { event, body, comments }) {
  return once(`${t.id}:submit`, () => {
    const payload = {
      commit_id: t.pr.headSha, event, body,
      comments: comments.map((c) => ({
        path: c.path, line: c.line, side: c.side || 'RIGHT', body: c.body,
        ...(c.start_line && c.start_line < c.line ? { start_line: c.start_line, start_side: c.side || 'RIGHT' } : {}),
      })),
    };
    const res = JSON.parse(gh(['api', '-X', 'POST', `repos/${t.pr.slug}/pulls/${t.pr.number}/reviews`, '--input', '-'], JSON.stringify(payload)));
    const d = readReview(t);
    const entry = { at: Date.now(), url: res.html_url, state: res.state, event, body, comments };
    // Posted drafts move to history so the panel starts clean for a follow-up review.
    Object.assign(d, { summary: '', event: 'COMMENT', comments: [], history: [...(d.history || []), entry] });
    writeJson(t.reviewFile, d);
    return entry;
  });
}

const headChecked = new Map();
function refreshHead(t, force) {
  if (!force && Date.now() - (headChecked.get(t.id) || 0) < 30_000) return;
  headChecked.set(t.id, Date.now());
  try {
    const sha = gh(['pr', 'view', String(t.pr.number), '-R', t.pr.slug, '--json', 'headRefOid', '-q', '.headRefOid']).trim();
    if (!sha || sha === t.pr.headSha) return;
    // A contributing checkout stays on the PR branch; Ship's rebase picks up the author's commits.
    if (t.contribute) git(t.cwd, 'fetch', 'origin', `${t.branch}:refs/remotes/origin/${t.branch}`);
    else {
      git(t.cwd, 'fetch', 'origin', `pull/${t.pr.number}/head`);
      try { git(t.cwd, 'checkout', '--detach', 'FETCH_HEAD'); } catch {}
    }
    t.pr.headSha = sha;
    save();
    publish();
  } catch {}
}

// Points the review session at what changed since it last reviewed: new commits and new discussion.
function reviewUpdate(t, { comments = 0, reviews = 0, commits = 0 } = {}) {
  const from = t.pr.reviewedSha || t.pr.headSha;
  refreshHead(t, true);
  const to = t.pr.headSha;
  const what = [commits && `${commits} new commit${commits > 1 ? 's' : ''}`, comments && `${comments} new comment${comments > 1 ? 's' : ''}`,
    reviews && `${reviews} new review${reviews > 1 ? 's' : ''}`].filter(Boolean).join(', ') || 'new activity';
  const range = from && from !== to ? ` The head moved from ${from.slice(0, 9)} to ${to.slice(0, 9)}; see \`git diff ${from.slice(0, 9)} ${to.slice(0, 9)}\` (the checkout is already at the new head).` : '';
  ask(t, `PR #${t.pr.number} has ${what} since you last looked.${range} Read the new comments with \`gh pr view ${t.pr.number} -R ${t.pr.slug} --comments\`. \
Update the draft in ${t.reviewFile}: drop comments the new commits fixed, keep the rest, and add any new findings, without repeating anything in history. Then reply with a short summary of what changed.`);
  t.pr.reviewedSha = to;
  save();
  markSeen(`${t.pr.slug.toLowerCase()}#${t.pr.number}`);
  return t;
}

// ---- Addressing feedback on my own PRs ----

function listMine() {
  const q = `{viewer{pullRequests(states:OPEN,first:50,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url isDraft
    updatedAt headRefName reviewDecision repository{nameWithOwner} reviewThreads(first:100){nodes{isResolved}}}}}}`;
  const nodes = JSON.parse(gh(['api', 'graphql', '-f', `query=${q}`])).data.viewer.pullRequests.nodes;
  return nodes.map((p) => {
    const slug = p.repository.nameWithOwner.toLowerCase();
    return {
      slug, number: p.number, title: p.title, url: p.url, draft: p.isDraft, updatedAt: p.updatedAt, branch: p.headRefName,
      decision: p.reviewDecision, unresolved: p.reviewThreads.nodes.filter((x) => !x.isResolved).length, author: whoami(),
      taskId: prTask(slug, p.number)?.id,
    };
  });
}

const THREADS_Q = `query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){
  reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine diffSide
    comments(first:50){nodes{author{login} body createdAt url diffHunk}}}}
  reviews(first:50){nodes{id author{login} state body submittedAt url}}
  comments(first:50){nodes{id author{login} body createdAt url}}}}}`;

function fetchThreads(t) {
  const [o, n] = prOf(t).slug.split('/');
  const pr = JSON.parse(gh(['api', 'graphql', '-f', `query=${THREADS_Q}`, '-f', `o=${o}`, '-f', `n=${n}`, '-F', `num=${prOf(t).number}`]))
    .data.repository.pullRequest;
  const me = whoami().toLowerCase();
  const who = (a) => a?.login || 'ghost';
  const threads = pr.reviewThreads.nodes.map((th) => ({
    id: th.id, path: th.path, line: th.line ?? th.originalLine, side: th.diffSide, resolved: th.isResolved, outdated: th.isOutdated,
    hunk: th.comments.nodes[0]?.diffHunk || '',
    comments: th.comments.nodes.map((c) => ({ author: who(c.author), body: c.body, at: c.createdAt, url: c.url })),
  }));
  const general = [
    ...pr.reviews.nodes.filter((r) => r.body.trim())
      .map((r) => ({ id: r.id, kind: 'review', state: r.state, author: who(r.author), body: r.body, at: r.submittedAt, url: r.url })),
    ...pr.comments.nodes.map((c) => ({ id: c.id, kind: 'comment', author: who(c.author), body: c.body, at: c.createdAt, url: c.url })),
  ].filter((g) => g.author.toLowerCase() !== me).sort((a, b) => a.at.localeCompare(b.at));
  const data = { pr: prOf(t), me: whoami(), threads, general, fetchedAt: Date.now() };
  writeJson(fbThreads(t), data);
  return data;
}

function worktreeFor(repo, branch) {
  for (const block of git(repo, 'worktree', 'list', '--porcelain').split('\n\n')) {
    if (new RegExp(`^branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(block)) {
      return block.match(/^worktree (.+)$/m)[1];
    }
  }
}

const addressPrompt = (pr, threadsFile, file) => `You own PR #${pr.number} in ${pr.slug}: "${pr.title}". Reviewers left feedback; address it. \
The PR branch is checked out in this directory. Review threads and general comments are in ${threadsFile}; Situation Room refreshes it, \
so re-read it whenever you are asked to look again. For each unresolved thread that is not outdated, and each general comment that asks \
for something: decide whether a code change is warranted. If it is, make it in this checkout. If not, draft a short reply explaining why. \
Write your drafts as JSON to ${file}: {"replies": [{"thread": string, "body": string, "fixed": boolean, "resolve": boolean}], "commitMessage": string}. \
"thread" is the thread or comment id from the threads file. Replies are short, plain and first person: what changed, or why not. \
Set resolve to true only when your change fully settles the thread. commitMessage is one imperative line covering the fixes. ${NO_AI} \
Do not commit, push or post anything: the author checks your changes, posts the replies from Situation Room and pushes. \
The drafts file may be edited while you work, so re-read it before changing it. \
Keep entries marked "dismissed": true as they are and draft nothing for those threads. When done, reply here with a short summary of what you changed.`;

// The task already handling feedback on a PR of yours: an address task, or one that adopted it.
function prTask(slug, number) {
  return state.tasks.find((t) => kindOf(t) === 'address' && t.pr.slug === slug && t.pr.number === Number(number))
    || state.tasks.find((t) => t.fb?.pr.slug === slug && t.fb.pr.number === Number(number));
}
// A plain task whose checkout is on the PR's branch made that PR; its conversation should take the feedback.
function branchOwner(repoPath, branch) {
  const live = (t) => fs.existsSync(t.cwd) && (() => { try { return git(t.cwd, 'branch', '--show-current') === branch; } catch { return false; } })();
  return state.tasks.filter((t) => !t.pr && !t.fb && t.repoPath === repoPath && live(t))
    .sort((a, b) => (procs.has(`${b.id}:claude`) - procs.has(`${a.id}:claude`)) || (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))[0];
}
// Gives an existing task the PR's feedback: drafts files, the Feedback tab, and the prompt as its next message.
function adoptFeedback(t, p, slug) {
  const pr = { slug, number: p.number, title: p.title, author: whoami(), headSha: p.headRefOid, url: p.url, mine: true };
  const file = path.join(REVIEWS, `${t.id}.feedback.json`);
  const threads = path.join(REVIEWS, `${t.id}.feedback.threads.json`);
  if (!fs.existsSync(file)) writeJson(file, { replies: [], commitMessage: '' });
  t.fb = { pr, file, threads };
  try { git(t.cwd, 'fetch', 'origin', p.headRefName); git(t.cwd, 'merge', '--ff-only', `origin/${p.headRefName}`); } catch {}
  fetchThreads(t);
  save();
  publish();
  ask(t, addressPrompt(pr, threads, file));
  return t;
}

function createAddressTask({ slug, number, resumeId, fork, ...choice }) {
  const existing = prTask(slug, number);
  if (existing) return existing;
  const agent = agentOf(choice);
  const src = sessionSource(resumeId, agent.harness, fork);
  const repoPath = localClone(slug);
  if (!repoPath) throw new Error(`no local clone of ${slug} under ${config.roots.join(', ')}`);
  const p = JSON.parse(gh(['pr', 'view', String(number), '-R', slug, '--json', 'number,title,headRefOid,headRefName,url']));
  const branch = p.headRefName;
  // A session ID means the user wants a fresh task; otherwise the task that made the branch takes the feedback.
  const owner = !resumeId && branchOwner(repoPath, branch);
  if (owner) return adoptFeedback(owner, p, slug);
  const id = `fix-${p.number}-${crypto.randomBytes(2).toString('hex')}`;
  git(repoPath, 'fetch', 'origin', branch);
  let cwd = worktreeFor(repoPath, branch);
  if (!cwd) {
    cwd = path.join(HOME, 'worktrees', id);
    let local = true;
    try { git(repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`); } catch { local = false; }
    if (local) git(repoPath, 'worktree', 'add', cwd, branch);
    else git(repoPath, 'worktree', 'add', '--track', '-b', branch, cwd, `origin/${branch}`);
    copyLocalFiles(repoPath, cwd);
  }
  try { git(cwd, 'merge', '--ff-only', `origin/${branch}`); } catch {}
  const pr = { slug, number: p.number, title: p.title, author: whoami(), headSha: p.headRefOid, url: p.url, mine: true };
  const reviewFile = path.join(REVIEWS, `${id}.json`);
  const threadsFile = path.join(REVIEWS, `${id}.threads.json`);
  writeJson(reviewFile, { replies: [], commitMessage: '' });
  const t = {
    id, kind: 'address', name: `Fix #${p.number} ${p.title}`, repo: path.basename(repoPath), repoPath, cwd, branch,
    label: `Your PR #${p.number} · ${branch}`, pr, reviewFile, threadsFile, prompt: addressPrompt(pr, threadsFile, reviewFile), git: true,
    ...resumeFields(src, fork, agent.harness, cwd), status: 'idle', createdAt: Date.now(), ...agent,
  };
  kickoff(t);
  fetchThreads(t);
  state.tasks.push(t);
  save();
  publish();
  return t;
}

// Feedback on your own PR lives either on an address task or on the task that made the branch ("adopted").
const fbFile = (t) => t.fb?.file || t.reviewFile;
const fbThreads = (t) => t.fb?.threads || t.threadsFile;
const hasFeedback = (t) => kindOf(t) === 'address' || !!t.fb;
const prOf = (t) => t.fb?.pr || t.pr;

const threadsAt = new Map();
function addressState(t, force) {
  let data = readJson(fbThreads(t), null);
  if (force || !data || Date.now() - (threadsAt.get(t.id) || 0) > 20_000) {
    threadsAt.set(t.id, Date.now());
    data = fetchThreads(t);
  }
  let changed = [];
  try { changed = git(t.cwd, 'status', '--porcelain').split('\n').filter(Boolean); } catch {}
  let ahead = 0;
  try { ahead = Number(git(t.cwd, 'rev-list', '--count', `origin/${t.branch}..HEAD`)); } catch {}
  return { ...data, draft: readJson(fbFile(t), { replies: [], commitMessage: '' }), changed, ahead, cwd: t.cwd, branch: t.branch };
}

const REPLY_M = 'mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}';
const RESOLVE_M = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';

function postReply(t, { thread, body, resolve }) {
  return once(`${t.id}:${thread}`, () => {
    const d = readJson(fbFile(t), { replies: [] });
    d.replies ||= [];
    let r = d.replies.find((x) => x.thread === thread);
    if (r?.posted && r.posted.body === body && (!resolve || r.posted.resolved)) throw new Error('already posted');
    let url = null;
    if (body?.trim()) {
      if (thread.startsWith('PRRT_')) {
        url = JSON.parse(gh(['api', 'graphql', '-f', `query=${REPLY_M}`, '-f', `id=${thread}`, '-f', `body=${body}`]))
          .data.addPullRequestReviewThreadReply.comment.url;
      } else {
        const g = readJson(fbThreads(t), { general: [] }).general.find((x) => x.id === thread);
        const quote = g ? `> @${g.author}: ${g.body.split('\n')[0].slice(0, 200)}\n\n` : '';
        url = JSON.parse(gh(['api', '-X', 'POST', `repos/${prOf(t).slug}/issues/${prOf(t).number}/comments`, '-f', `body=${quote}${body}`])).html_url;
      }
    }
    if (resolve && thread.startsWith('PRRT_')) gh(['api', 'graphql', '-f', `query=${RESOLVE_M}`, '-f', `id=${thread}`]);
    if (!r) d.replies.push((r = { thread }));
    r.body = body;
    r.posted = { at: Date.now(), url, body, resolved: !!resolve };
    writeJson(fbFile(t), d);
    fetchThreads(t);
    return r.posted;
  });
}

// ---- Watching PRs I own or review ----

const WATCH_Q = `fragment P on PullRequest { number title url isDraft updatedAt author{login} repository{nameWithOwner}
  commits(last:5){nodes{commit{oid committedDate author{user{login}}}}}
  comments(last:30){nodes{author{login} createdAt}}
  reviews(last:30){nodes{author{login} submittedAt state}}
  reviewThreads(last:60){nodes{comments(last:20){nodes{author{login} createdAt}}}} }
{ mine: search(query:"is:open is:pr archived:false author:@me", type:ISSUE, first:40){nodes{...P}}
  asked: search(query:"is:open is:pr archived:false review-requested:@me", type:ISSUE, first:40){nodes{...P}}
  reviewed: search(query:"is:open is:pr archived:false reviewed-by:@me", type:ISSUE, first:40){nodes{...P}} }`;

state.prSeen ||= {};
let watched = { at: 0, items: [] };

// Async so a slow GitHub call never stalls terminal output.
function ghAsync(args) {
  return new Promise((res, rej) => execFile('gh', args, { maxBuffer: 50e6 }, (e, out) => (e ? rej(e) : res(out))));
}

let polling;
async function pollPrs() {
  if (polling) return polling;
  let d;
  polling = ghAsync(['api', 'graphql', '-f', `query=${WATCH_Q}`]).then((o) => JSON.parse(o).data, () => null);
  try { d = await polling; } finally { polling = null; }
  if (!d) return;
  const me = whoami().toLowerCase();
  const items = new Map();
  for (const [role, res] of [['author', d.mine], ['reviewer', d.asked], ['reviewer', d.reviewed]]) {
    for (const p of res?.nodes || []) {
      if (!p?.number) continue;
      const key = `${p.repository.nameWithOwner.toLowerCase()}#${p.number}`;
      if (items.has(key)) continue;
      // First sight sets the baseline, so existing history never counts as new.
      const seen = (state.prSeen[key] ||= Date.now());
      const other = (a) => a && a.login.toLowerCase() !== me;
      const after = (at) => at && Date.parse(at) > seen;
      const comments = [
        ...p.comments.nodes.filter((c) => other(c.author) && after(c.createdAt)),
        ...p.reviewThreads.nodes.flatMap((th) => th.comments.nodes).filter((c) => other(c.author) && after(c.createdAt)),
      ].length;
      const reviews = p.reviews.nodes.filter((r) => other(r.author) && after(r.submittedAt) && r.state !== 'COMMENTED').length;
      const commits = p.commits.nodes.filter((c) => after(c.commit.committedDate) && c.commit.author?.user?.login?.toLowerCase() !== me).length;
      items.set(key, {
        key, slug: p.repository.nameWithOwner.toLowerCase(), number: p.number, title: p.title, url: p.url, role,
        author: p.author?.login, comments, reviews, commits, unread: comments + reviews + commits,
      });
    }
  }
  const prev = new Map(watched.items.map((i) => [i.key, i.unread]));
  watched = { at: Date.now(), items: [...items.values()] };
  save();
  const fresh = watched.items.filter((i) => i.unread > (prev.get(i.key) || 0));
  broadcast({ t: 'prwatch', ...watched, fresh: watched.at && prev.size ? fresh.map((i) => i.key) : [] });
}

function markSeen(key) {
  state.prSeen[key] = Date.now();
  for (const i of watched.items) if (i.key === key) Object.assign(i, { comments: 0, reviews: 0, commits: 0, unread: 0 });
  save();
  broadcast({ t: 'prwatch', ...watched, fresh: [] });
}

// A bad GitHub reply must never take the daemon, and every session with it, down.
const pollSafe = () => pollPrs().catch((e) => console.error('prwatch', e.message));
setTimeout(pollSafe, 4000);
setInterval(pollSafe, 90_000);
refreshPrices();
setInterval(refreshPrices, 6 * 3600_000);

// ---- Jira ----

function jiraAuth() {
  const f = expand(config.jira.envFile);
  const txt = fs.readFileSync(f, 'utf8');
  const get = (k) => txt.match(new RegExp(`^${k}=["']?(.*?)["']?\\s*$`, 'm'))?.[1];
  const user = get('JIRA_USERNAME') || get('JIRA_EMAIL');
  const token = get('JIRA_API_TOKEN');
  if (!user || !token) throw new Error(`JIRA_USERNAME and JIRA_API_TOKEN not found in ${f}`);
  return 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
}

async function jira(method, p, payload) {
  const r = await fetch(config.jira.base + p, {
    method, body: payload && JSON.stringify(payload),
    headers: { authorization: jiraAuth(), accept: 'application/json', 'content-type': 'application/json' },
  });
  const txt = await r.text();
  const j = txt ? readJsonStr(txt) : {};
  if (!r.ok) throw new Error(j.errorMessages?.join('; ') || Object.values(j.errors || {}).join('; ') || `Jira ${r.status}`);
  return j;
}

let jiraMe;
const jiraMyself = async () => (jiraMe ||= await jira('GET', '/rest/api/3/myself'));

const OPEN = 'statusCategory != Done ORDER BY updated DESC';
const JQL = {
  forme: `(assignee = currentUser() OR watcher = currentUser() OR comment ~ currentUser()) AND ${OPEN}`,
  assigned: `assignee = currentUser() AND ${OPEN}`,
  mentioned: `comment ~ currentUser() AND ${OPEN}`,
  watching: `watcher = currentUser() AND ${OPEN}`,
  reported: `reporter = currentUser() AND ${OPEN}`,
};

const NO_EPIC = 'issuetype != Epic';

// Follows nextPageToken up to `limit` issues.
async function jiraSearch(jql, fields, limit = 500) {
  const issues = [];
  let nextPageToken;
  do {
    const r = await jira('POST', '/rest/api/3/search/jql', { jql, fields, maxResults: 100, nextPageToken });
    issues.push(...r.issues);
    nextPageToken = r.nextPageToken;
  } while (nextPageToken && issues.length < limit);
  return { issues };
}

async function jiraList(filter, projects) {
  const me = await jiraMyself();
  const team = (config.jira.team || []).filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k));
  let base = JQL[filter] || JQL.forme;
  if ((filter || 'forme') === 'forme' && team.length) base = base.replace(/^\(/, `(project in (${team.join(',')}) OR `);
  const keys = (projects || []).filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k));
  const scoped = keys.length ? `project in (${keys.join(',')}) AND ${NO_EPIC} AND ${base}` : `${NO_EPIC} AND ${base}`;
  const [j, all] = await Promise.all([
    jiraSearch(scoped, ['summary', 'status', 'priority', 'issuetype', 'updated', 'project', 'assignee', 'parent']),
    // Unscoped and light, so the project chips list every project the filter touches.
    keys.length ? jiraSearch(`${NO_EPIC} AND ${base}`, ['project']) : null,
  ]);
  const counts = new Map();
  for (const { fields: f } of (all || j).issues) {
    const c = counts.get(f.project.key) || { key: f.project.key, name: f.project.name, n: 0 };
    c.n++;
    counts.set(f.project.key, c);
  }
  const issues = j.issues.map(({ key, fields: f }) => ({
    key, summary: f.summary, status: f.status.name, cat: f.status.statusCategory.key, type: f.issuetype.name,
    priority: f.priority?.name, updated: f.updated, project: f.project.key,
    assignee: f.assignee?.displayName || null, mine: f.assignee?.accountId === me.accountId,
    epic: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary } : null,
    url: `${config.jira.base}/browse/${key}`, taskId: state.tasks.find((t) => t.jira?.key === key)?.id,
  }));
  return { issues, projects: [...counts.values()].sort((a, b) => b.n - a.n) };
}

async function jiraIssue(key) {
  const i = await jira('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?expand=renderedFields`
    + '&fields=summary,description,status,priority,issuetype,assignee,reporter,parent,comment,labels,updated,created,project');
  const f = i.fields;
  const rc = i.renderedFields?.comment?.comments || [];
  const cs = f.comment?.comments || [];
  return {
    key: i.key, summary: f.summary, status: f.status.name, cat: f.status.statusCategory.key, type: f.issuetype.name,
    priority: f.priority?.name, project: f.project.key, labels: f.labels, updated: f.updated, created: f.created,
    assignee: f.assignee?.displayName || null, assigneeId: f.assignee?.accountId || null, reporter: f.reporter?.displayName || null,
    epic: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary } : null,
    text: f.description || '', html: i.renderedFields?.description || '',
    comments: cs.map((c, n) => ({ author: c.author?.displayName, at: c.created, text: c.body, html: rc[n]?.body || '' })).slice(-15),
    url: `${config.jira.base}/browse/${i.key}`, taskId: state.tasks.find((t) => t.jira?.key === i.key)?.id,
  };
}

async function jiraMeta(project) {
  const [types, epics] = await Promise.all([
    jira('GET', `/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`).catch(() => ({})),
    jira('POST', '/rest/api/3/search/jql', { jql: `project = "${project}" AND issuetype = Epic AND ${OPEN}`, maxResults: 50, fields: ['summary'] })
      .catch(() => ({ issues: [] })),
  ]);
  return {
    types: (types.issueTypes || types.values || []).filter((x) => !x.subtask && x.name !== 'Epic').map((x) => x.name),
    epics: epics.issues.map((e) => ({ key: e.key, summary: e.fields.summary })),
    repo: config.jira.repos[project] || null,
  };
}

// One-shot headless Claude call that must answer with a JSON object.
// One-shot helper call, under the same config dir (and so the same login) as the task it serves.
function claudeJson(prompt, t) {
  return new Promise((resolve, reject) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-lc', 'exec claude -p --no-session-persistence --tools "" --output-format json "$SR_Q"'],
      { cwd: os.tmpdir(), env: cleanEnv({ SR_Q: prompt, ...claudeEnv(t) }), timeout: 180_000, maxBuffer: 10e6 }, (err, out) => {
        try {
          const r = JSON.parse(out);
          if (r.is_error) throw new Error(r.result);
          resolve(JSON.parse(r.result.match(/\{[\s\S]*\}/)[0]));
        } catch (e) { reject(err || e); }
      });
  });
}

function draftTicket({ idea, project, type, epic, current }) {
  const prev = current?.summary ? `\nThe current draft, which the note may be refining:\nSummary: ${current.summary}\nDescription:\n${current.description}\n` : '';
  return claudeJson(`Write a Jira ${type || 'Task'} for project ${project}${epic ? ` under the epic "${epic}"` : ''} from this rough note:

<note>
${idea}
</note>
${prev}
Answer with only a JSON object {"summary": string, "description": string}.
summary: specific and scannable, at most 80 characters, starts with a verb or the component, no ticket key, no trailing period.
description: Jira wiki markup, written so whoever picks it up can start without asking. Use these sections, skipping any with nothing real to say:
h3. Context (why this matters, one or two sentences), h3. What to do (short bullets with *), h3. Done when (checklist bullets), h3. Open questions.
Use only facts from the note; never invent systems, names or numbers. Be concise. ${NO_AI}`);
}

async function jiraCreate({ project, type, summary, description, epic, assignToMe }) {
  const fields = { project: { key: project }, issuetype: { name: type || 'Task' }, summary, description };
  if (epic) fields.parent = { key: epic };
  if (assignToMe) fields.assignee = { accountId: (await jiraMyself()).accountId };
  const r = await jira('POST', '/rest/api/2/issue', { fields });
  return { key: r.key, url: `${config.jira.base}/browse/${r.key}` };
}

const jiraPrompt = (i) => `Pick up Jira ticket ${i.key}: "${i.summary}" (${i.type}, ${i.status}). ${i.url}
${i.epic ? `Epic: ${i.epic.key} ${i.epic.summary}\n` : ''}
Description:
${(i.text || '(none)').slice(0, 8000)}
${i.comments.length ? `\nComments:\n${i.comments.map((c) => `- ${c.author}: ${c.text}`).join('\n').slice(0, 6000)}` : ''}

This checkout is on a fresh branch off main for the ticket. Understand the relevant code, give a short plan, then implement it. \
Do not commit, push, or change the Jira ticket; it is already assigned and in progress, and the human handles the rest.`;

// Assign to me and move to In Progress; a ticket already in progress or later keeps its status.
async function jiraClaim(i) {
  const me = await jiraMyself();
  if (i.assigneeId !== me.accountId) await jira('PUT', `/rest/api/2/issue/${i.key}/assignee`, { accountId: me.accountId });
  if (i.cat !== 'new') return;
  const { transitions } = await jira('GET', `/rest/api/2/issue/${i.key}/transitions`);
  const to = transitions.find((x) => x.to.name === 'In Progress') || transitions.find((x) => x.to.statusCategory.key === 'indeterminate' && x.to.name !== 'Review');
  if (to) await jira('POST', `/rest/api/2/issue/${i.key}/transitions`, { transition: { id: to.id } });
}

async function jiraStart({ key, repoPath, reassign, ...choice }) {
  const existing = state.tasks.find((t) => t.jira?.key === key);
  if (existing) return existing;
  const i = await jiraIssue(key);
  const me = await jiraMyself();
  if (i.assigneeId && i.assigneeId !== me.accountId && !reassign) return { needsReassign: true, assignee: i.assignee };
  const t = await createTask({
    name: `${i.key} ${i.summary}`, repoPath: repoPath || config.jira.repos[i.project] || config.jira.repos[i.key.split('-')[0]], ...choice,
    extra: { kind: 'jira', jira: { key: i.key, summary: i.summary, url: i.url }, label: `${i.key} · ${i.type}`, prompt: jiraPrompt(i) },
  });
  // The task exists either way; a Jira failure is reported, not fatal.
  try { await jiraClaim(i); } catch (e) { return { ...t, jiraError: `Could not assign or move ${i.key}: ${e.message}` }; }
  return t;
}

// ---- Shipping: commits, push, draft PR ----

function gitRaw(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 50e6, stdio: ['ignore', 'pipe', 'pipe'] });
}
function baseRef(cwd) {
  try { return git(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'); } catch { return 'origin/main'; }
}
const shipFile = (t) => path.join(REVIEWS, `${t.id}.ship.json`);
const jiraKeyOf = (t, branch) => t.jira?.key || `${t.name} ${branch}`.match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] || null;

function changedFiles(cwd) {
  const f = gitRaw(cwd, 'status', '--porcelain', '-z', '-uall').split('\0');
  const out = [];
  for (let i = 0; i < f.length; i++) {
    if (!f[i]) continue;
    const st = f[i].slice(0, 2);
    const e = { st: st.trim()[0] || 'M', path: f[i].slice(3) };
    if (/[RC]/.test(st)) e.from = f[++i];
    if (st === '??') e.st = 'A';
    out.push(e);
  }
  return out;
}

const prAt = new Map(); // `${slug}:${branch}` -> { at, pr }
function branchPr(slug, branch) {
  const k = `${slug}:${branch}`;
  const hit = prAt.get(k);
  if (hit && Date.now() - hit.at < 30_000) return hit.pr;
  let pr = null;
  try {
    const list = JSON.parse(gh(['pr', 'list', '-R', slug, '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,isDraft,state,title']));
    pr = list[0] || null;
  } catch {}
  prAt.set(k, { at: Date.now(), pr });
  return pr;
}

function shipState(t) {
  const cwd = t.cwd;
  const branch = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const base = baseRef(cwd);
  const baseName = base.replace(/^origin\//, '');
  let upstream = null;
  try { upstream = git(cwd, 'rev-parse', '--abbrev-ref', '@{u}'); } catch {}
  const range = `${upstream && !upstream.endsWith(`/${baseName}`) ? '@{u}' : base}..HEAD`;
  let commits = [];
  try { commits = git(cwd, 'log', '--format=%h%x09%s', range).split('\n').filter(Boolean).map((l) => ({ sha: l.split('\t')[0], message: l.slice(l.indexOf('\t') + 1) })); } catch {}
  const slug = originSlug(t.repoPath || cwd);
  const onBase = branch === baseName || branch === 'HEAD';
  const pr = slug && !onBase ? branchPr(slug, branch) : null;
  const draft = readJson(shipFile(t), { commits: [], branch: '', pr: { title: '', body: '' } });
  const hint = hasFeedback(t) ? readJson(fbFile(t), {}).commitMessage || '' : '';
  return { branch, base, baseName, onBase, upstream, slug, labels: slug && !t.onMain ? kindLabels(slug) : [], files: changedFiles(cwd), commits, pr: t.onMain ? null : pr, jiraKey: jiraKeyOf(t, branch), draft, hint, onMain: !!(t.onMain && onBase && mainAllowed(t)) };
}

function shipDiff(cwd, files) {
  let d = '';
  try { d = gitRaw(cwd, 'diff', 'HEAD', '--stat', '--patch'); } catch {}
  for (const f of files.filter((x) => x.st === 'A')) {
    try {
      if (!d.includes(`b/${f.path}\n`)) d += `\n--- new file ${f.path}\n${fs.readFileSync(path.join(cwd, f.path), 'utf8').slice(0, 4000)}`;
    } catch {}
  }
  return d.length > 90_000 ? `${d.slice(0, 90_000)}\n[diff truncated]` : d;
}

// A note older than the last commit belongs to work already shipped.
function freshNote(t) {
  try {
    const f = noteFile(t);
    const head = Number(git(t.cwd, 'log', '-1', '--format=%ct')) * 1000;
    return fs.statSync(f).mtimeMs > head ? fs.readFileSync(f, 'utf8').trim().slice(0, 8000) : '';
  } catch { return ''; }
}

async function shipPlan(t, note) {
  const s = shipState(t);
  if (!s.files.length) throw new Error('No uncommitted changes to plan.');
  let history = [];
  try { history = git(t.cwd, 'log', '--format=%s', '--no-merges', '-30', s.base).split('\n'); } catch {}
  const prev = s.draft.commits?.length ? `\nThe current plan, which the note may be refining:\n${JSON.stringify({ commits: s.draft.commits, branch: s.draft.branch, pr: s.draft.pr })}\n` : '';
  const kinds = s.slug && !s.onMain ? kindLabels(s.slug) : [];
  const shipNote = freshNote(t);
  const out = await claudeJson(`Plan how to commit ${s.onMain ? `these changes straight to ${s.baseName} (no branch, no pull request)` : 'and open a pull request for these changes'} in the ${path.basename(t.repoPath || t.cwd)} repo.

Task: ${t.name}
Jira ticket: ${s.jiraKey || 'none'}
Current branch: ${s.branch}${s.onBase ? ' (the default branch, so a new branch is needed)' : ''}
Already committed, not pushed: ${s.commits.map((c) => c.message).join(' | ') || 'none'}
A pull request ${s.pr ? `already exists: #${s.pr.number} ${s.pr.title}` : 'does not exist yet'}.

Recent commit subjects on ${s.base}, newest first. Match their style exactly: casing, prefixes, ticket keys, length:
${history.map((h) => `- ${h}`).join('\n')}

Changed files (status, path):
${s.files.map((f) => `${f.st} ${f.path}`).join('\n')}

Diff:
${shipDiff(t.cwd, s.files)}
${prev}${shipNote ? `\nThe session that made the change left this ship note. Base the commit messages and PR on it:\n<note>\n${shipNote}\n</note>\n` : ''}${note ? `\nNote from the author: ${note}\n` : ''}
${kinds.length ? `Pick the one label that best describes the change, from this repo's labels:\n${kinds.map((l) => `- ${l.name}: ${l.description || ''}`).join('\n')}\n` : ''}
Answer with only a JSON object {"commits": [{"message": string, "files": [string]}], "branch": string, "pr": {"title": string, "body": string${kinds.length ? ', "label": string' : ''}}}.
commits: split into several commits only where the changes are clearly separate concerns; otherwise one commit. Order them so each builds on the last.
Every changed file appears in exactly one commit. Each message is one line, imperative, no body, no trailing period, in the history's style.
${s.jiraKey ? `Start each message and the PR title with ${s.jiraKey} the way the history does.` : 'If the history marks commits without a ticket in some way, follow it.'}
The "Bump chart appVersion" style commits are automated; do not copy them.
branch: ${s.onBase || /^(situation-room|cockpit)\//.test(s.branch) ? 'a short kebab-case branch name for this work, no prefix' : `"${s.branch}"`}.
pr.title: the main commit's style. pr.body: ${shipNote ? 'the PR body from the ship note, keeping its wording and facts' : 'two to five short lines of markdown saying what changed and why'}. No headings, no checklist, no testing section, no filler. ${NO_AI}`, t);
  const known = new Set(s.files.map((f) => f.path));
  const seen = new Set();
  const commits = (out.commits || []).map((c) => ({
    message: String(c.message || '').split('\n')[0].trim(),
    files: (c.files || []).filter((f) => known.has(f) && !seen.has(f) && seen.add(f)),
  })).filter((c) => c.message && c.files.length);
  const left = [...known].filter((f) => !seen.has(f));
  if (left.length) commits.length ? commits.at(-1).files.push(...left) : commits.push({ message: 'Update', files: left });
  // Only a label the repo really has is kept; a made-up one would fail the PR command.
  const label = kinds.find((l) => l.name.toLowerCase() === String(out.pr?.label || '').toLowerCase())?.name || '';
  const draft = { commits, branch: String(out.branch || s.branch).trim(), pr: { title: out.pr?.title || commits[0]?.message || '', body: out.pr?.body || '', label }, plannedAt: Date.now() };
  writeJson(shipFile(t), draft);
  return draft;
}

// Tracked changes plus untracked files, without touching the index.
function fullDiff(cwd) {
  let d = '';
  try { d = gitRaw(cwd, 'diff', 'HEAD', '-M'); } catch {}
  for (const f of changedFiles(cwd).filter((x) => x.st === 'A' && !d.includes(` b/${x.path}\n`))) {
    try { gitRaw(cwd, 'diff', '--no-index', '--', '/dev/null', f.path); } catch (e) { d += e.stdout?.toString().slice(0, 200_000) || ''; }
  }
  return d;
}

const sq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
// A push straight to the default branch needs the task's space to allow it, checked at ship time too.
const mainAllowed = (t) => !!(t.space && config.spaces?.[t.space]?.allowMain);

// Builds the one-line command the user runs in Shell; Situation Room never runs it.
function shipCommand(t, d) {
  writeJson(shipFile(t), d);
  const s = shipState(t);
  const byPath = new Map(s.files.map((f) => [f.path, f]));
  const steps = [];
  const branch = String(d.branch || '').trim();
  if (s.onMain) {
    for (const c of d.commits || []) {
      const fs_ = (c.files || []).map((p) => byPath.get(p)).filter(Boolean);
      if (!fs_.length || !c.message?.trim()) continue;
      const paths = fs_.flatMap((f) => (f.from ? [f.from, f.path] : [f.path])).map(sq).join(' ');
      steps.push(`git add -A -- ${paths} && git commit -q -m ${sq(c.message.trim().split('\n')[0])} -- ${paths}`);
    }
    if (!steps.length && !s.commits.length) throw new Error('Nothing to commit or push.');
    // Rebase onto the latest so a push to main never needs force.
    steps.push(`git pull --rebase -q origin ${sq(s.baseName)}`, `git push origin HEAD:${sq(s.baseName)}`);
    return { steps, cmd: steps.join(' && '), onMain: true };
  }
  // Someone else's PR: never rename its branch or open a new PR; rebase onto their latest and push to it.
  const theirs = t.contribute && kindOf(t) === 'review';
  if (theirs) {
    if (s.branch !== t.branch) throw new Error(`expected to be on ${t.branch}, but the checkout is on ${s.branch}`);
  } else if (branch && branch !== s.branch) {
    if (!/^[\w./-]+$/.test(branch)) throw new Error(`invalid branch name: ${branch}`);
    steps.push(s.onBase ? `git switch -c ${sq(branch)}` : `git branch -m ${sq(branch)}`);
  }
  for (const c of d.commits || []) {
    const fs_ = (c.files || []).map((p) => byPath.get(p)).filter(Boolean);
    if (!fs_.length || !c.message?.trim()) continue;
    const paths = fs_.flatMap((f) => (f.from ? [f.from, f.path] : [f.path])).map(sq).join(' ');
    steps.push(`git add -A -- ${paths} && git commit -q -m ${sq(c.message.trim().split('\n')[0])} -- ${paths}`);
  }
  const committing = steps.some((x) => x.startsWith('git add'));
  if (theirs) {
    if (!committing && !s.commits.length) throw new Error('Nothing to commit or push.');
    steps.push(`git pull --rebase -q origin ${sq(t.branch)}`, `git push origin HEAD:${sq(t.branch)}`);
    prAt.clear();
    return { steps, cmd: steps.join(' && '), theirs: true };
  }
  if (!committing && !s.commits.length && !s.pr) throw new Error('Nothing to commit or push.');
  if (s.onBase && !(branch && branch !== s.branch)) throw new Error(`On ${s.branch}; set a branch name first.`);
  steps.push('git push -u origin HEAD');
  if (!s.pr || s.pr.state !== 'OPEN') {
    if (!d.pr?.title?.trim()) throw new Error('The PR needs a title.');
    const bodyFile = path.join(REVIEWS, `${t.id}.prbody.md`);
    fs.writeFileSync(bodyFile, String(d.pr.body || '').trim() + '\n');
    const label = String(d.pr.label || '').trim();
    if (label && s.slug && !repoLabels(s.slug).some((l) => l.name === label)) throw new Error(`${s.slug} has no label "${label}".`);
    // Assigned to whoever opens it; gh resolves @me to the signed-in account.
    steps.push(`gh pr create --draft --base ${sq(s.baseName)} --title ${sq(d.pr.title.trim())} --body-file ${sq(bodyFile)} --assignee @me${label ? ` --label ${sq(label)}` : ''}`);
  }
  prAt.clear();
  return { steps, cmd: steps.join(' && ') };
}

// Sends a message to a task's Claude session; a stopped session gets it as its launch prompt.
function ask(t, text) {
  const line = String(text || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!line) return;
  const e = procs.get(`${t.id}:claude`);
  if (!e) { t.pending = line; save(); return spawn(t, 'claude'); }
  e.pty.write(line);
  setTimeout(() => e.pty.write('\r'), 150);
}


let reviewTimer;
fs.watch(REVIEWS, (_ev, file) => {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(() => {
    const t = state.tasks.find((x) => fbFile(x) && path.basename(fbFile(x)) === file.replace('.threads', ''));
    if (t) broadcast({ t: 'review', id: t.id });
  }, 150);
});

const isWorktree = (t) => !!t.repoPath && t.cwd !== t.repoPath && fs.existsSync(t.cwd);

// What deleting a worktree would lose: uncommitted files, and commits on no remote (review heads are the PR's own).
// Unpushed commits count unless the worktree is a plain review checkout or its PR is closed.
const riskKind = (t, closed) => (closed || (kindOf(t) === 'review' && !t.contribute) ? 'review' : t.contribute ? 'contribute' : kindOf(t));

function worktreeRisk(cwd, kind) {
  const risk = [];
  try { const n = git(cwd, 'status', '--porcelain').split('\n').filter(Boolean).length; if (n) risk.push(`${n} uncommitted file${n > 1 ? 's' : ''}`); } catch { return []; }
  if (kind !== 'review') {
    try { const n = Number(git(cwd, 'rev-list', '--count', 'HEAD', '--not', '--remotes')); if (n) risk.push(`${n} unpushed commit${n > 1 ? 's' : ''}`); } catch {}
  }
  return risk;
}

function dropWorktree(repoPath, cwd) {
  try { git(repoPath, 'worktree', 'remove', '--force', cwd); } catch { fs.rmSync(cwd, { recursive: true, force: true }); try { git(repoPath, 'worktree', 'prune'); } catch {} }
}

// closed: the PR is merged or closed, so unpushed commits are already in it and only uncommitted files count.
function removeTask(id, { worktree = true, force = false, closed = false } = {}) {
  const t = task(id);
  if (!t || t.id === 'builder') return {};
  // A closed PR's commits are already on GitHub, so a manual remove treats it like the sweep does.
  if (!closed && isWorktree(t) && (prOf(t) || t.branch)) { try { closed = ['MERGED', 'CLOSED'].includes(prStateOf(t)); } catch {} }
  // A worktree another task still works in stays, whatever the caller asked.
  const shared = state.tasks.some((x) => x.id !== id && x.cwd === t.cwd);
  const wt = worktree && !shared && isWorktree(t);
  const risk = wt ? worktreeRisk(t.cwd, riskKind(t, closed)) : [];
  if (risk.length && !force) return { risk };
  for (const k of ['claude', 'shell']) procs.get(`${id}:${k}`)?.pty.kill();
  // The branch stays; only the worktree folder goes.
  if (wt) dropWorktree(t.repoPath, t.cwd);
  fs.rmSync(noteFile(t), { force: true });
  state.tasks = state.tasks.filter((x) => x.id !== id);
  save();
  publish();
  return { removed: true };
}

function prStateOf(t) {
  const pr = prOf(t);
  const slug = pr?.slug || originSlug(t.repoPath);
  if (!slug) return null;
  if (pr?.number) { try { return JSON.parse(gh(['pr', 'view', String(pr.number), '-R', slug, '--json', 'state'])).state; } catch { return null; } }
  if (!t.branch) return null;
  return branchPr(slug, t.branch)?.state || null;
}

function sweepWorktrees() {
  for (const t of [...state.tasks]) {
    // A pinned task is kept on purpose, so the sweep leaves it.
    if (t.pinned || ['working', 'waiting'].includes(t.status) || !(prOf(t) || t.branch)) continue;
    if (!['MERGED', 'CLOSED'].includes(prStateOf(t))) continue;
    const r = removeTask(t.id, { closed: true });
    if (r.removed) console.log(`swept ${t.id}: PR ${prStateOf(t).toLowerCase()}`);
    else if (r.risk) console.log(`kept ${t.id}: PR closed but ${r.risk.join(', ')}`);
  }
  // git reports real paths; tasks may hold a symlinked spelling of the same folder.
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const owned = new Set(state.tasks.flatMap((t) => [t.cwd, real(t.cwd)]));
  const legacy = real(path.join(HOME, 'worktrees'));
  for (const r of listRepos()) {
    let list = [];
    let blocks = [];
    try { blocks = git(r.path, 'worktree', 'list', '--porcelain').split('\n\n').slice(1); } catch {}
    // A worktree on a branch some task is on is never an orphan, whatever its path.
    const taken = new Set(state.tasks.filter((t) => t.repoPath === r.path && t.branch).map((t) => `refs/heads/${t.branch}`));
    list = blocks.filter((b) => !taken.has(b.match(/^branch (.+)$/m)?.[1])).map((b) => b.match(/^worktree (.+)$/m)?.[1]).filter(Boolean);
    // Only worktrees Situation Room made: the old home, or a <repo>-<branch> sibling.
    for (const cwd of list.filter((c) => !owned.has(c) && (c.startsWith(legacy + '/') || path.basename(c).startsWith(`${r.name}-`)))) {
      // A review checkout is detached; one on a branch may hold commits for someone's PR.
      const detached = blocks.some((b) => b.startsWith(`worktree ${cwd}\n`) && /^detached$/m.test(b));
      if (worktreeRisk(cwd, cwd.includes('/pr-') && detached ? 'review' : '').length) continue;
      // An agent may have just made it and not written to it yet; leave anything under an hour old.
      try { if (Date.now() - fs.statSync(cwd).birthtimeMs < 3600_000) continue; } catch { continue; }
      dropWorktree(r.path, cwd);
      console.log(`swept orphan ${cwd}`);
    }
  }
}
const sweepSafe = () => { try { sweepWorktrees(); } catch (e) { console.error('sweep', e.message); } };
setTimeout(sweepSafe, 60_000);
setInterval(sweepSafe, 15 * 60_000);

function diff(t) {
  try {
    const status = git(t.cwd, 'status', '--short', '--branch');
    const d = execFileSync('git', ['-C', t.cwd, 'diff', 'HEAD', '--stat', '--patch'], { encoding: 'utf8', maxBuffer: 20e6 });
    return `${status}\n\n${d || '(no changes against HEAD)'}`;
  } catch (e) {
    return `not a git checkout: ${t.cwd}\n${e.message}`;
  }
}

function body(req) {
  return new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  // The renderer is a file:// page, so every call is cross-origin.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (req.method === 'POST' && parts[0] === 'hook') {
      const t = task(parts[1]);
      const payload = readJsonStr(await body(req));
      if (t) {
        if (!t.started) { t.started = true; save(); }
        // A fork gets its own id on first launch; keep it so relaunches resume the fork, not the source.
        if (t.fork && t.harness !== 'pi' && payload.session_id && payload.session_id !== t.sessionId) {
          t.sessionId = payload.session_id; t.fork = false; save(); publish();
        }
        const ev = parts[2];
        // Pi reports its session at startup and on every model switch.
        if (ev === 'session') {
          const m = String(payload.model || '');
          if (m && (modelOf(m) || !gatewayOn()) && m !== t.model) { t.model = m; save(); publish(); }
          return json(200, {});
        }
        // idle_prompt fires after Stop; only a permission prompt means "needs you".
        if (ev === 'notify' && payload.notification_type === 'idle_prompt') return json(200, {});
        setStatus(t, ev === 'notify' ? 'waiting' : ev);
        if (ev === 'done' || ev === 'notify') broadcast({ t: 'attention', id: t.id, status: t.status, message: payload.message });
      }
      return json(200, {});
    }
    if (req.method === 'POST' && parts[0] === 'shutdown') {
      json(200, {});
      for (const e of procs.values()) e.pty.kill();
      return setTimeout(() => process.exit(0), 200);
    }
    if (req.method === 'GET' && parts[0] === 'repos') { const sp = config.spaces?.[url.searchParams.get('space')]; return json(200, listRepos(sp ? sp.roots : config.roots)); }
    if (req.method === 'GET' && parts[0] === 'diff') {
      const t = task(parts[1]);
      res.writeHead(t ? 200 : 404, { 'content-type': 'text/plain' });
      return res.end(t ? diff(t) : 'no such task');
    }
    if (parts[0] === 'whoami') return json(200, { login: whoami() });
    if (req.method === 'GET' && parts[0] === 'mine') return json(200, listMine());
    if (parts[0] === 'address') {
      if (req.method === 'POST' && !parts[1]) return json(200, createAddressTask(readJsonStr(await body(req))));
      // Which task would take this PR's feedback, so the UI can skip the agent picker.
      if (req.method === 'GET' && parts[1] === 'owner') {
        const slug = url.searchParams.get('slug'), number = Number(url.searchParams.get('number'));
        const have = prTask(slug, number);
        if (have) return json(200, { id: have.id, name: have.name });
        const repoPath = localClone(slug);
        const branch = repoPath && JSON.parse(gh(['pr', 'view', String(number), '-R', slug, '--json', 'headRefName'])).headRefName;
        const o = branch && branchOwner(repoPath, branch);
        return json(200, o ? { id: o.id, name: o.name } : {});
      }
      const t = task(parts[1]);
      if (!t || !hasFeedback(t)) return json(404, { error: 'not a feedback task' });
      if (req.method === 'GET') return json(200, { ...addressState(t, url.searchParams.has('force')), login: whoami() });
      if (req.method === 'PUT') { writeJson(fbFile(t), readJsonStr(await body(req))); return json(200, {}); }
      if (req.method === 'POST' && parts[2] === 'reply') return json(200, postReply(t, readJsonStr(await body(req))));
      if (req.method === 'POST' && parts[2] === 'ask') { ask(t, readJsonStr(await body(req)).text); return json(200, {}); }
    }
    if (parts[0] === 'prwatch') {
      if (req.method === 'POST' && parts[1] === 'seen') { markSeen(String(readJsonStr(await body(req)).key || '')); return json(200, {}); }
      if (req.method === 'POST' && parts[1] === 'poll') { await pollPrs(); return json(200, watched); }
      return json(200, watched);
    }
    if (parts[0] === 'ship') {
      const t = task(parts[1]);
      if (!t) return json(404, { error: 'no such task' });
      if (req.method === 'GET' && parts[2] === 'diff') { const d = fullDiff(t.cwd); res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(d); }
      if (req.method === 'GET') return json(200, shipState(t));
      if (req.method === 'PUT') { writeJson(shipFile(t), readJsonStr(await body(req))); return json(200, {}); }
      if (req.method === 'POST' && parts[2] === 'plan') return json(200, await shipPlan(t, readJsonStr(await body(req)).note));
      if (req.method === 'POST' && parts[2] === 'command') return json(200, shipCommand(t, readJsonStr(await body(req))));
    }
    if (parts[0] === 'jira') {
      if (!config.jira) return json(400, { error: 'Jira is not configured; add a "jira" section to config.json.' });
      const b = req.method === 'POST' ? readJsonStr(await body(req)) : {};
      if (parts[1] === 'issues') return json(200, await jiraList(url.searchParams.get('filter'), (url.searchParams.get('projects') || '').split(',').filter(Boolean)));
      if (parts[1] === 'issue') return json(200, await jiraIssue(parts[2]));
      if (parts[1] === 'meta') return json(200, await jiraMeta(url.searchParams.get('project') || config.jira.defaultProject));
      if (parts[1] === 'draft') return json(200, await draftTicket(b));
      if (parts[1] === 'create') return json(200, await jiraCreate(b));
      if (parts[1] === 'start') return json(200, await jiraStart(b));
    }
    if (req.method === 'GET' && parts[0] === 'config') {
      const pi = gatewayOn() ? MODELS : nativePiModels();
      return json(200, {
        roots: config.roots, prRepos: config.prRepos, gateway: gatewayOn(),
        jira: !!config.jira, jiraBase: config.jira?.base, jiraProject: config.jira?.defaultProject, jiraRepos: config.jira?.repos || {},
        logs: !!(config.logs?.url || fs.existsSync(path.join(__dirname, '.env'))),
        spaces: Object.fromEntries(Object.entries(config.spaces || {}).map(([k, v]) => [k, { label: v.label || k, roots: v.roots, login: !!v.claudeConfigDir, allowMain: !!v.allowMain }])),
        // Claude Code takes catalog models; Pi takes the gateway catalog or whatever Pi itself can reach.
        models: MODELS.filter((m) => m.claude).map(({ id, label, ctx, cost }) => ({ id, label, ctx, cost, claude: true }))
          .concat(pi.map(({ id, label, ctx, cost }) => ({ id, label, ctx, cost, pi: true }))),
        piModel: config.pi.model || pi[0]?.id || '',
      });
    }
    if (parts[0] === 'prs') {
      const slug = parts.slice(1, 3).join('/');
      if (req.method === 'GET' && !slug) return json(200, config.prRepos.map((s) => ({ slug: s, path: localClone(s) || null })));
      if (req.method === 'GET' && parts[3] && parts[4] === 'comments') return json(200, prTalk(slug, parts[3]));
      if (req.method === 'GET' && parts[3]) return json(200, prDetail(slug, parts[3]));
      if (req.method === 'GET') return json(200, listPrs(slug));
      if (req.method === 'POST') {
        const s = String(readJsonStr(await body(req)).slug || '').trim().toLowerCase();
        if (!/^[\w.-]+\/[\w.-]+$/.test(s)) return json(400, { error: 'use owner/name' });
        if (!config.prRepos.includes(s)) { config.prRepos.push(s); saveConfig(); }
        return json(200, {});
      }
      if (req.method === 'DELETE') { config.prRepos = config.prRepos.filter((s) => s !== slug); saveConfig(); return json(200, {}); }
    }
    if (parts[0] === 'review') {
      if (req.method === 'POST' && !parts[1]) return json(200, createReviewTask(readJsonStr(await body(req))));
      const t = task(parts[1]);
      if (!t || kindOf(t) !== 'review') return json(404, { error: 'not a review task' });
      if (req.method === 'GET') { refreshHead(t); return json(200, { pr: t.pr, draft: readReview(t), diff: prDiff(t), login: whoami() }); }
      if (req.method === 'POST' && parts[2] === 'ask') { ask(t, readJsonStr(await body(req)).text); return json(200, {}); }
      if (req.method === 'POST' && parts[2] === 'update') return json(200, reviewUpdate(t, readJsonStr(await body(req))));
      if (req.method === 'POST' && parts[2] === 'contribute') return json(200, contributeToPr(t));
      if (req.method === 'PUT') { fs.writeFileSync(t.reviewFile, JSON.stringify(readJsonStr(await body(req)), null, 2)); return json(200, {}); }
      if (req.method === 'POST' && parts[2] === 'submit') return json(200, submitReview(t, readJsonStr(await body(req))));
    }
    if (req.method === 'POST' && parts[0] === 'tasks') return json(200, await createTask(readJsonStr(await body(req))));
    // Small edits from the task menu; only these fields, and the Builder stays pinned.
    if (req.method === 'PATCH' && parts[0] === 'tasks') {
      const t = task(parts[1]);
      if (!t) return json(404, { error: 'no such task' });
      const b = readJsonStr(await body(req));
      if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim().slice(0, 120);
      if (typeof b.pinned === 'boolean' && t.id !== 'builder') t.pinned = b.pinned;
      if (b.status === 'idle' && ['done', 'stopped', 'waiting'].includes(t.status)) t.status = 'idle';
      // Turning push-to-main on for an existing task: allowed space, and its checkout already on the default branch.
      if (b.onMain === true && !t.onMain) {
        if (!mainAllowed(t)) return json(400, { error: 'this task is not in a space that allows working on main' });
        if (!t.git) return json(400, { error: 'not a git checkout' });
        const base = baseRef(t.cwd).replace(/^origin\//, '');
        if (git(t.cwd, 'branch', '--show-current') !== base) return json(400, { error: `switch the task's checkout to ${base} first` });
        t.onMain = true;
        t.branch = base;
      }
      if (b.onMain === false) delete t.onMain;
      // Moving a task to another checkout of its repo: the folder must be a git worktree of the same repo.
      if (typeof b.cwd === 'string' && b.cwd !== t.cwd) {
        const cwd = expand(b.cwd);
        if (procs.has(`${t.id}:claude`) || procs.has(`${t.id}:shell`)) return json(409, { error: 'stop the task first' });
        let common;
        try { common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'); } catch { return json(400, { error: `not a git checkout: ${cwd}` }); }
        if (t.repoPath && common !== git(t.repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir')) return json(400, { error: 'that folder belongs to another repo' });
        moveSession(t, cwd);
        t.branch = git(cwd, 'branch', '--show-current') || null;
        t.worktree = cwd !== t.repoPath;
        t.git = isGit(cwd);
      }
      save();
      publish();
      return json(200, t);
    }
    if (req.method === 'DELETE' && parts[0] === 'tasks') {
      return json(200, removeTask(parts[1], { worktree: url.searchParams.get('worktree') !== '0', force: url.searchParams.get('force') === '1' }));
    }
    if (req.method === 'GET' && parts[0] === 'tasks' && parts[2] === 'risk') {
      const t = task(parts[1]);
      const own = !!t && isWorktree(t) && !state.tasks.some((x) => x.id !== t.id && x.cwd === t.cwd);
      const closed = own && (prOf(t) || t.branch) && ['MERGED', 'CLOSED'].includes(prStateOf(t));
      return json(200, { worktree: own, cwd: t?.cwd, risk: own ? worktreeRisk(t.cwd, riskKind(t, closed)) : [] });
    }
    json(404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) return res.end();
    json(500, { error: e.stderr?.toString() || e.message });
  }
});

function readJsonStr(s) { try { return JSON.parse(s); } catch { return {}; } }

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({ t: 'tasks', tasks: state.tasks }));
  if (watched.at) ws.send(JSON.stringify({ t: 'prwatch', ...watched, fresh: [] }));
  ws.on('message', (raw) => {
    const m = readJsonStr(raw.toString());
    const t = task(m.id);
    if (!t) return;
    if (m.t === 'attach') {
      const e = spawn(t, m.kind, m.cols, m.rows);
      ws.send(JSON.stringify({ t: 'replay', id: t.id, kind: m.kind, data: [...e.modes].map((n) => `\x1b[?${n}h`).join('') + e.buf }));
    } else if (m.t === 'in') procs.get(`${t.id}:${m.kind}`)?.pty.write(m.data);
    else if (m.t === 'resize') procs.get(`${t.id}:${m.kind}`)?.pty.resize(m.cols, m.rows);
    else if (m.t === 'seen' && (t.status === 'done' || t.status === 'stopped')) setStatus(t, 'idle');
    else if (m.t === 'restart') { procs.get(`${t.id}:${m.kind}`)?.pty.kill(); }
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`situation-room daemon on :${PORT}`));
