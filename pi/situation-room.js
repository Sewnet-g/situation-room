// Reports status to the Situation Room daemon and enforces PR-task tool limits from $SR_GATE.
import path from 'node:path';

const url = (ev) => `http://127.0.0.1:${process.env.SR_PORT}/hook/${process.env.SR_TASK}/${ev}`;
const post = (ev, body = {}) => fetch(url(ev), { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(2000) }).catch(() => {});
const gate = process.env.SR_GATE ? JSON.parse(process.env.SR_GATE) : null;
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

function allowed(ev, cwd) {
  if (READ_TOOLS.has(ev.toolName)) return true;
  if (ev.toolName === 'write' || ev.toolName === 'edit') {
    const p = path.resolve(cwd, ev.input.path || '');
    return gate.write.some((d) => p === d || p.startsWith(d + path.sep));
  }
  if (ev.toolName === 'bash') {
    const c = String(ev.input.command || '').trim();
    return !/[;&|`<>$()\n]/.test(c) && gate.bash.some((b) => c === b || c.startsWith(b + ' '));
  }
  return false;
}

export default function (pi) {
  const info = (ctx) => ({ session_id: ctx.sessionManager.getSessionId(), session_file: ctx.sessionManager.getSessionFile(), model: ctx.model && (ctx.model.provider === 'gateway' ? ctx.model.id : `${ctx.model.provider}/${ctx.model.id}`) });
  pi.on('session_start', (_e, ctx) => post('session', info(ctx)));
  pi.on('model_select', (_e, ctx) => post('session', info(ctx)));
  pi.on('agent_start', () => post('working'));
  pi.on('tool_execution_start', () => post('working'));
  pi.on('ui_prompt_start', (e) => post('notify', { message: e.title || 'Pi is waiting for input' }));
  pi.on('ui_prompt_end', () => post('working'));
  pi.on('agent_settled', () => post('done'));
  pi.on('tool_call', (ev, ctx) => {
    if (!gate || allowed(ev, ctx.cwd)) return undefined;
    return { block: true, reason: `Not allowed in this task. Use read/grep/find/ls, write only under ${gate.write.join(', ')}, and bash only for: ${gate.bash.join(', ')} (one plain command, no pipes or chaining).` };
  });
}
