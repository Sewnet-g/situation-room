// Usage breakdown sheet: cost and tokens by model and harness, daily chart, and a what-if against one reference model.

// Categorical order, validated for CVD separation on the dark surface; a model keeps its slot whatever the filter.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const RANGES = [[0, 'This month'], [7, '7 days'], [30, '30 days'], [90, '90 days']];
let uRange = Number(store.get('uRange', 0));
let uRef = store.get('uRef', 'anthropic-claude-opus-5-5');
let uSheet = null;

const slotOf = (id) => {
  const i = (config.models || []).findIndex((m) => m.id === id);
  return i < 0 ? '#7c828f' : SERIES[i % SERIES.length];
};
const isFree = (id) => { const m = (config.models || []).find((x) => x.id === id); return !!m && !m.cost.some(Boolean); };
const tokOf = (r) => r.input + r.output + r.cacheRead + r.cacheWrite;
const H = { claude: 'Claude Code', pi: 'Pi', login: 'Claude login' };

async function usageSheet() {
  if (!window.sr?.usageDetail) return;
  if (uSheet) return;
  if (!config.models) config = await api('/config').catch(() => config);
  const d = (uSheet = document.createElement('dialog'));
  d.className = 'sheet wide usage-sheet';
  d.innerHTML = '<div class="us"><div class="loading">Reading transcripts…</div></div>';
  document.body.appendChild(d);
  d.onclose = () => { d.remove(); uSheet = null; };
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.showModal();
  await drawUsage();
}

async function drawUsage() {
  const d = uSheet;
  if (!d) return;
  const u = await window.sr.usageDetail({ days: uRange, ref: uRef }).catch((e) => ({ error: e.message }));
  if (uSheet !== d) return;
  const box = d.querySelector('.us');
  if (u.error) { box.innerHTML = `<div class="loading err">${esc(u.error)}</div>`; return; }
  const rows = u.rows.sort((a, b) => b.cost - a.cost || tokOf(b) - tokOf(a));
  const total = rows.reduce((a, r) => a + r.cost, 0);
  const refTotal = rows.reduce((a, r) => a + r.ref, 0);
  const tok = rows.reduce((a, r) => a + tokOf(r), 0);
  const by = { claude: 0, pi: 0 };
  const loginTok = rows.filter((r) => r.harness === 'login').reduce((a, r) => a + tokOf(r), 0);
  for (const r of rows) if (r.harness in by) by[r.harness] += r.cost;
  const models = [...new Set(rows.map((r) => r.model))];
  const refModel = (config.models || []).find((m) => m.id === uRef);
  const saved = refTotal - total;

  box.innerHTML = `
    <header class="us-head">
      <h3>Usage</h3>
      <div class="seg" id="us-range">${RANGES.map(([v, l]) => `<button data-v="${v}" class="${v === uRange ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="ghost icon" id="us-close" title="Close (Esc)">✕</button>
    </header>
    <div class="us-tiles">
      <div class="us-tile"><span>Spent</span><b>${fmtUsd(total)}</b><small>${fmtTok(tok)} tokens</small></div>
      <div class="us-tile"><span>Claude Code</span><b>${fmtUsd(by.claude)}</b><small>${pct(by.claude, total)} of spend</small></div>
      <div class="us-tile"><span>Pi</span><b>${fmtUsd(by.pi)}</b><small>${pct(by.pi, total)} of spend</small></div>
      ${loginTok ? `<div class="us-tile" title="Runs on the Claude subscription login, not billed per token"><span>Claude login</span><b>${fmtTok(loginTok)}</b><small>tokens on subscription</small></div>` : ''}
      <div class="us-tile ${saved > 0.005 ? 'good' : ''}" title="What the same tokens would have cost on the reference model">
        <span>All on <select id="us-ref">${(config.models || []).filter((m) => m.cost.some(Boolean)).map((m) => `<option value="${esc(m.id)}" ${m.id === uRef ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></span>
        <b>${fmtUsd(refTotal)}</b><small>${saved > 0.005 ? `${fmtUsd(saved)} saved by switching` : saved < -0.005 ? `${fmtUsd(-saved)} more than all on ${esc(refModel?.label || '')}` : 'same as actual'}</small>
      </div>
    </div>
    <div class="us-chart" id="us-chart"></div>
    <div class="us-legend">${models.map((m) => `<span><i style="background:${slotOf(m)}"></i>${esc(modelLabel(m))}</span>`).join('')}</div>
    <table class="us-table">
      <thead><tr><th>Model</th><th>Harness</th><th class="n">Turns</th><th class="n">In</th><th class="n">Cache</th><th class="n">Out</th><th class="n">Cost</th><th class="n" title="Same tokens on ${esc(refModel?.label || '')}">On ${esc(refModel?.label || 'ref')}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><i class="sw" style="background:${slotOf(r.model)}"></i>${esc(modelLabel(r.model))}</td>
        <td><span class="hz hz-${r.harness}">${H[r.harness]}</span></td>
        <td class="n">${r.turns.toLocaleString()}</td>
        <td class="n">${fmtTok(r.input + r.cacheWrite)}</td>
        <td class="n">${fmtTok(r.cacheRead)}</td>
        <td class="n">${fmtTok(r.output)}</td>
        <td class="n"><b>${r.harness === 'login' ? '<span class="free" title="Covered by the subscription">subscription</span>' : !r.cost && isFree(r.model) ? '<span class="free" title="No price on the gateway yet">no price yet</span>' : fmtUsd(r.cost)}</b></td>
        <td class="n dim">${fmtUsd(r.ref)}</td></tr>`).join('') || '<tr><td colspan="8" class="dim">No usage in this range.</td></tr>'}</tbody>
    </table>
    <p class="us-note">From local transcripts at gateway prices. Each message is counted once, even when a fork or resume copies it. Models with no gateway price count as $0 until one is set.</p>`;

  drawChart($('#us-chart', box), u.daily, models);
  box.querySelector('#us-close').onclick = () => d.close();
  box.querySelector('#us-ref').onchange = (e) => { uRef = e.target.value; store.set('uRef', uRef); drawUsage(); };
  for (const b of $$('#us-range button', box)) b.onclick = () => { uRange = Number(b.dataset.v); store.set('uRange', String(uRange)); drawUsage(); };
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');

// Stacked daily cost per model, as SVG with one hover target per day.
function drawChart(el, daily, models) {
  const W = 820, Hh = 170, L = 44, R = 8, T = 10, B = 22;
  const days = daily.map((x) => ({ day: x.day, segs: models.map((m) => ({ m, v: x.m[m]?.cost || 0, t: x.m[m]?.tokens || 0 })) }));
  const max = Math.max(1, ...days.map((x) => x.segs.reduce((a, s) => a + s.v, 0)));
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const bw = (W - L - R) / days.length;
  const y = (v) => T + (Hh - T - B) * (1 - v / top);
  const bar = Math.max(2, Math.min(22, bw - 3));
  let svg = '';
  for (let v = 0; v <= top + 1e-9; v += step) svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 3.5}" class="ax" text-anchor="end">$${v >= 10 ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1)}</text>`;
  const every = Math.ceil(days.length / 10);
  days.forEach((x, i) => {
    const cx = L + bw * i + bw / 2;
    let acc = 0;
    const live = x.segs.filter((s) => s.v > 0);
    live.forEach((s, j) => {
      const y0 = y(acc), y1 = y(acc + s.v);
      acc += s.v;
      // 2px surface gap between stacked segments; only the top end is rounded.
      const h = Math.max(0, y0 - y1 - (j ? 2 : 0));
      if (h <= 0) return;
      const r = j === live.length - 1 ? Math.min(3, h / 2, bar / 2) : 0;
      svg += `<path d="${roundTop(cx - bar / 2, y1, bar, h, r)}" fill="${slotOf(s.m)}"/>`;
    });
    if (i % every === 0 || i === days.length - 1) svg += `<text x="${cx}" y="${Hh - 6}" class="ax" text-anchor="middle">${fmtDay(x.day, days.length)}</text>`;
    svg += `<rect x="${L + bw * i}" y="${T}" width="${bw}" height="${Hh - T - B}" class="hit" data-i="${i}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" role="img" aria-label="Daily cost by model">${svg}</svg><div class="us-tip" hidden></div>`;
  const tip = el.querySelector('.us-tip');
  for (const h of el.querySelectorAll('.hit')) {
    h.onmouseenter = () => {
      const x = days[h.dataset.i];
      const live = x.segs.filter((s) => s.v || s.t);
      const sum = x.segs.reduce((a, s) => a + s.v, 0);
      tip.innerHTML = `<b>${new Date(x.day).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}</b><span class="tv">${fmtUsd(sum)}</span>
        ${live.map((s) => `<div><i style="background:${slotOf(s.m)}"></i>${esc(modelLabel(s.m))}<span>${s.v ? fmtUsd(s.v) : fmtTok(s.t)}</span></div>`).join('') || '<div class="dim">No usage</div>'}`;
      tip.hidden = false;
      const r = h.getBoundingClientRect(), p = el.getBoundingClientRect();
      const left = r.left - p.left + r.width / 2;
      tip.style.left = `${Math.min(Math.max(left, 90), p.width - 90)}px`;
      h.classList.add('on');
    };
    h.onmouseleave = () => { tip.hidden = true; h.classList.remove('on'); };
  }
}

function roundTop(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(v || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= v) || p * 10;
}
const fmtDay = (day, n) => new Date(day).toLocaleDateString('en', n > 14 ? { month: 'short', day: 'numeric' } : { weekday: 'short', day: 'numeric' });

$('#u-more').onclick = usageSheet;
