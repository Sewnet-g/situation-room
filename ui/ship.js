// Changes and Ship drawer tabs. Loaded after app.js.

const ST = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict' };
const sig = (s) => JSON.stringify([s.branch, s.files, s.commits, s.pr]);

// ---- Changes ----

function splitDiff(txt) {
  const files = new Map();
  let curf = null;
  for (const l of txt.split('\n')) {
    if (l.startsWith('diff --git')) { curf = { path: l.split(' b/').pop(), lines: [], add: 0, del: 0 }; files.set(curf.path, curf); continue; }
    if (!curf || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) continue;
    if (l.startsWith('+')) curf.add++;
    else if (l.startsWith('-')) curf.del++;
    curf.lines.push(l);
  }
  return files;
}

async function loadChanges(force) {
  const t = cur();
  if (!t) return;
  if (changes?.id === t.id && !force) return renderChanges();
  if (changes?.id !== t.id) $('#dbody').innerHTML = skeletonPanel();
  try {
    const [s, d] = await Promise.all([api(`/ship/${t.id}`), api(`/ship/${t.id}/diff`)]);
    if (current !== t.id) return;
    const open = changes?.id === t.id ? changes.open : new Set();
    changes = { id: t.id, s, files: splitDiff(d), open, sig: sig(s) };
  } catch (e) { $('#dbody').innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  renderChanges();
}

function renderChanges() {
  const t = cur();
  if (!changes || changes.id !== current || ptabOf(t) !== 'changes' || $('#drawer').hidden) return;
  const { s, files, open } = changes;
  let add = 0, del = 0;
  for (const f of files.values()) { add += f.add; del += f.del; }
  const d = $('#dbody');
  d.innerHTML = `
    <header class="dh">
      <div><h4>Changes</h4><small>${ICON.branch}${esc(s.branch)}</small></div>
      ${s.files.length ? `<span class="stat"><b class="a">+${add}</b><b class="d">−${del}</b></span>` : ''}
      <button class="ghost icon xs" id="ch-refresh" title="Refresh">↻</button>
    </header>
    <div class="db" id="ch-list"></div>
    ${s.files.length || s.commits.length ? `<footer class="df"><span class="dim">${s.files.length ? plural(s.files.length, 'file') : 'Working tree clean'}${s.commits.length ? ` · ${s.commits.length} unpushed` : ''}</span>
      <button class="primary" id="ch-ship">${ICON.ship} Ship…</button></footer>` : ''}`;
  $('#ch-refresh').onclick = () => loadChanges(true);
  if ($('#ch-ship')) $('#ch-ship').onclick = () => setPtab('ship');
  const list = $('#ch-list');
  if (!s.files.length) {
    list.innerHTML = emptyState('Working tree clean', s.commits.length ? `${plural(s.commits.length, 'commit')} waiting to be pushed. Ship pushes them.` : 'Edits the agent makes in this checkout show up here.');
    return;
  }
  for (const f of s.files) {
    const df = files.get(f.path) || { lines: [], add: 0, del: 0 };
    const el = document.createElement('div');
    el.className = 'cf' + (open.has(f.path) ? ' open' : '');
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    el.innerHTML = `<button class="cfh"><span class="caret">›</span><span class="fst s-${f.st}" title="${ST[f.st] || f.st}">${f.st}</span>
      <span class="loc"><span class="dir">${esc(dir)}</span><b>${esc(f.path.slice(dir.length))}</b></span>
      <span class="stat"><b class="a">${df.add ? `+${df.add}` : ''}</b><b class="d">${df.del ? `−${df.del}` : ''}</b></span></button>`;
    if (open.has(f.path)) el.insertAdjacentHTML('beforeend', `<pre class="snip cfd">${df.lines.slice(0, 600).map((l) => {
      const c = l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
      return `<span class="${c}">${esc(l || ' ')}</span>`;
    }).join('') || '<span class="ctx">Binary or empty file</span>'}</pre>`);
    el.querySelector('.cfh').onclick = () => { open.has(f.path) ? open.delete(f.path) : open.add(f.path); renderChanges(); };
    list.appendChild(el);
  }
}

// ---- Ship ----

async function loadShip(force) {
  const t = cur();
  if (!t) return;
  if (ship?.id === t.id && !force) return renderShip();
  if (ship?.id !== t.id) $('#dbody').innerHTML = skeletonPanel();
  let s;
  try { s = await api(`/ship/${t.id}`); } catch (e) { $('#dbody').innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  if (current !== t.id) return;
  const keep = ship?.id === t.id ? { busy: ship.busy, preview: ship.preview } : {};
  ship = { id: t.id, s, d: reconcile(s), sig: sig(s), ...keep };
  renderShip();
}

// Drops files that are no longer changed; new ones wait in "Not in a commit".
function reconcile(s) {
  const d = structuredClone(s.draft || {});
  d.commits ||= [];
  d.pr ||= { title: '', body: '' };
  const live = new Set(s.files.map((f) => f.path));
  for (const c of d.commits) c.files = (c.files || []).filter((p) => live.has(p));
  d.commits = d.commits.filter((c) => c.files.length || c.message);
  if (!d.commits.length && s.files.length && s.hint) d.commits.push({ message: s.hint, files: s.files.map((f) => f.path) });
  if (!d.branch) d.branch = s.onBase ? '' : s.branch;
  return d;
}

const loose = () => {
  const used = new Set(ship.d.commits.flatMap((c) => c.files));
  return ship.s.files.filter((f) => !used.has(f.path));
};

function saveShip() {
  clearTimeout(ship.timer);
  const { id, d } = ship;
  ship.timer = setTimeout(() => api(`/ship/${id}`, { method: 'PUT', body: d }).catch(() => {}), 350);
}

function shipAction(s, d) {
  const committing = d.commits.some((c) => c.files.length && c.message.trim());
  if (s.onMain) return committing ? `Commit & push to ${s.baseName}` : s.commits.length ? `Push to ${s.baseName}` : null;
  const open = s.pr?.state === 'OPEN';
  if (committing) return open ? 'Commit & push' : 'Commit & open draft PR';
  if (s.commits.length) return open ? 'Push' : 'Push & open draft PR';
  return open ? null : s.upstream && !s.onBase ? 'Open draft PR' : null;
}

function renderShip() {
  const t = cur();
  if (!ship || ship.id !== current || ptabOf(t) !== 'ship' || $('#drawer').hidden) return;
  const { s, d } = ship;
  const dbx = $('#dbody');
  const scroll = $('#sh-body')?.scrollTop || 0;
  const open = s.pr?.state === 'OPEN';
  const action = shipAction(s, d);
  const left = loose();
  const nothing = !s.files.length && !s.commits.length;
  const needBranch = !s.onMain && (s.onBase || /^(situation-room|cockpit)\//.test(s.branch));
  const prChip = s.pr ? `<a class="prchip ${s.pr.state === 'OPEN' ? (s.pr.isDraft ? 'draft' : 'open') : 'closed'}" href="${esc(s.pr.url)}">
      <span class="i"></span>#${s.pr.number} · ${s.pr.state === 'OPEN' ? (s.pr.isDraft ? 'Draft' : 'Open') : s.pr.state.toLowerCase()} <span class="ext">↗</span></a>` : '';
  dbx.innerHTML = `
    <header class="dh">
      <div><h4>Ship</h4>${s.onMain ? `<small class="flow onmain"><b>Straight to ${esc(s.baseName)}</b> · no branch, no PR</small>`
        : `<small class="flow"><span>${esc(s.baseName)}</span><i>←</i><b>${esc(needBranch && d.branch ? d.branch : s.branch)}</b></small>`}</div>
      ${prChip}
      <button class="ghost icon xs" id="sh-refresh" title="Refresh">↻</button>
    </header>
    <div class="db" id="sh-body"></div>
    ${nothing ? '' : `<div class="composer" id="sh-ask"></div>`}
    <footer class="df">
      <span class="dim sum">${shipSummary(s, d)}</span>
      <button class="primary" id="sh-go" ${action ? '' : 'disabled'}>${ICON.ship} ${action || 'Up to date'}</button>
    </footer>
    <div class="who">Runs in Shell as you. Nothing happens until you press Enter.</div>`;
  $('#sh-refresh').onclick = () => loadShip(true);
  $('#sh-go').onclick = runShip;
  const body = $('#sh-body');

  if (nothing) {
    body.innerHTML = open
      ? emptyState('All shipped', `Everything is on <b>${esc(s.branch)}</b> and in PR #${s.pr.number}.`)
      : emptyState('Nothing to ship', 'Changes the agent makes show up in the Changes tab, then here.');
    return;
  }

  // Branch
  if (needBranch && !open) {
    body.insertAdjacentHTML('beforeend', `<div class="lbl">Branch</div>
      <div class="field">${ICON.branch}<input id="sh-branch" value="${esc(d.branch)}" placeholder="short-kebab-name" spellcheck="false"></div>
      ${s.onBase ? `<p class="note">You're on <b>${esc(s.branch)}</b>; this creates the branch first.</p>` : `<p class="note">Renames <b>${esc(s.branch)}</b> before pushing.</p>`}`);
    $('#sh-branch').oninput = (e) => { d.branch = e.target.value.trim(); saveShip(); $('.flow b', dbx).textContent = d.branch || s.branch; };
  }

  // Commits
  const planned = d.commits.length;
  body.insertAdjacentHTML('beforeend', `<div class="lbl row"><span>Commits</span>
    ${s.files.length ? `<span class="lacts"><button class="ghost xs" id="sh-add" title="Add another commit">+ Commit</button></span>` : ''}</div>`);
  const rail = document.createElement('div');
  rail.className = 'rail';
  body.appendChild(rail);
  if (s.files.length && !planned) {
    rail.insertAdjacentHTML('beforeend', `<div class="plan-cta">
      <div class="pc-t"><b>${plural(s.files.length, 'changed file')}</b><span>Group them into commits written in this repo's style${s.jiraKey ? `, prefixed <code>${esc(s.jiraKey)}</code>` : ''}.</span></div>
      <div class="pc-a"><button class="primary" id="sh-plan">${ICON.spark} Plan commits</button><button class="ghost" id="sh-manual">Write my own</button></div></div>`);
    $('#sh-plan').onclick = () => plan();
    $('#sh-manual').onclick = () => { d.commits.push({ message: s.jiraKey ? `${s.jiraKey} ` : '', files: s.files.map((f) => f.path) }); saveShip(); renderShip(); focusMsg(0); };
  }
  d.commits.forEach((c, i) => rail.appendChild(commitCard(c, i)));
  if (left.length && planned) rail.appendChild(looseCard(left));
  for (const c of s.commits) {
    rail.insertAdjacentHTML('beforeend', `<div class="node done"><i class="knot"></i><div class="cc ro"><span class="sha mono">${esc(c.sha)}</span><span class="m">${esc(c.message)}</span><span class="tag">${open || s.upstream ? 'unpushed' : 'committed'}</span></div></div>`);
  }
  if ($('#sh-add')) $('#sh-add').onclick = () => { d.commits.push({ message: s.jiraKey ? `${s.jiraKey} ` : '', files: [] }); saveShip(); renderShip(); focusMsg(d.commits.length - 1); };

  // Pull request
  if (s.onMain) {
    body.insertAdjacentHTML('beforeend', `<p class="note onmain">These commits go straight to <b>${esc(s.baseName)}</b> on origin, after a rebase onto its latest. No pull request.</p>`);
  } else if (open) {
    body.insertAdjacentHTML('beforeend', `<div class="lbl">Pull request</div>
      <a class="prcard" href="${esc(s.pr.url)}"><span class="prc-i ${s.pr.isDraft ? 'draft' : ''}">${ICON.review}</span>
      <span><b>${esc(s.pr.title)}</b><small>#${s.pr.number} · ${s.pr.isDraft ? 'Draft' : 'Open'} · pushing updates it</small></span><span class="ext">↗</span></a>`);
  } else {
    body.insertAdjacentHTML('beforeend', `<div class="lbl row"><span>Pull request</span><span class="lock" title="Situation Room always opens PRs as drafts">Draft</span></div>
      <div class="prf">
        <input id="sh-title" value="${esc(d.pr.title)}" placeholder="${esc(d.commits[0]?.message || 'Title')}" spellcheck="false">
        <div class="prb">
          <div class="seg small" id="sh-mode"><button data-m="w" class="${ship.preview ? '' : 'on'}">Write</button><button data-m="p" class="${ship.preview ? 'on' : ''}">Preview</button></div>
          <span class="dim" id="sh-bl"></span>
        </div>
        ${ship.preview ? `<div class="md prev-md">${md(d.pr.body) || '<p class="dim">Nothing to preview.</p>'}</div>`
          : `<textarea id="sh-pbody" rows="3" placeholder="Two to five lines: what changed and why.">${esc(d.pr.body)}</textarea>`}
      </div>`);
    $('#sh-title').oninput = (e) => { d.pr.title = e.target.value; saveShip(); updateGo(); };
    for (const b of $$('#sh-mode button')) b.onclick = () => { ship.preview = b.dataset.m === 'p'; renderShip(); };
    const pb = $('#sh-pbody');
    const bl = () => { const n = d.pr.body.trim() ? d.pr.body.trim().split('\n').length : 0; $('#sh-bl').textContent = n ? `${plural(n, 'line')}` : ''; $('#sh-bl').classList.toggle('warn', n > 6); };
    bl();
    if (pb) { autogrow(pb); pb.oninput = () => { d.pr.body = pb.value; saveShip(); bl(); }; }
  }

  if ($('#sh-ask')) {
    const chips = s.files.length && planned
      ? [{ label: 'Replan' }, { label: 'One commit', note: 'Use a single commit for everything.' }, { label: 'Split more', note: 'Split into more commits where concerns differ.' }, { label: 'Shorter PR', note: 'Make the PR body shorter and plainer.' }]
      : !open && !s.onMain ? [{ label: 'Write PR', note: 'Only rewrite the PR title and body for the commits already on this branch.' }] : [];
    const el = $('#sh-ask');
    el.innerHTML = `${chips.length ? `<div class="chips">${chips.map((c, i) => `<button class="chip" data-i="${i}">${ICON.spark}${c.label}</button>`).join('')}</div>` : ''}
      <div class="ask"><textarea rows="1" placeholder="${planned ? 'Refine the plan: e.g. keep the test changes separate' : 'Notes for the plan (optional)'}"></textarea><button class="send" title="Plan (↵)">↑</button></div>`;
    const ta = el.querySelector('textarea');
    autogrow(ta);
    const go = () => plan(ta.value.trim());
    el.querySelector('.send').onclick = go;
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } };
    el.querySelectorAll('.chip').forEach((b) => (b.onclick = () => plan(chips[b.dataset.i].note)));
    if (!s.files.length && open) el.remove();
  }
  if (ship.busy) busyOverlay();
  body.scrollTop = scroll;
}

function shipSummary(s, d) {
  const n = d.commits.filter((c) => c.files.length && c.message.trim()).length;
  const parts = [];
  if (n) parts.push(plural(n, 'commit'));
  if (s.commits.length) parts.push(`${s.commits.length} unpushed`);
  const l = loose().length;
  if (l && d.commits.length) parts.push(`<span class="warn">${l} left out</span>`);
  return parts.join(' · ') || '';
}

function updateGo() {
  const b = $('#sh-go');
  if (!b) return;
  const a = shipAction(ship.s, ship.d);
  b.disabled = !a;
  b.innerHTML = `${ICON.ship} ${a || 'Up to date'}`;
  $('.df .sum').innerHTML = shipSummary(ship.s, ship.d);
}

function focusMsg(i) {
  const el = $$('#sh-body .cc input.msg')[i];
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

function fileRow(path, from) {
  const f = ship.s.files.find((x) => x.path === path) || { st: 'M', path };
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const el = document.createElement('div');
  el.className = 'sf';
  el.draggable = true;
  el.innerHTML = `<span class="grip">⋮⋮</span><span class="fst s-${f.st}" title="${ST[f.st] || f.st}">${f.st}</span>
    <span class="loc"><span class="dir">${esc(dir)}</span><b>${esc(path.slice(dir.length))}</b></span>
    <button class="ghost icon xs mv" title="Move to another commit">⇅</button>`;
  el.ondragstart = (e) => { e.dataTransfer.setData('text/x-file', JSON.stringify({ path, from })); el.classList.add('drag'); };
  el.ondragend = () => el.classList.remove('drag');
  el.querySelector('.mv').onclick = (e) => { e.stopPropagation(); moveMenu(e.currentTarget, path, from); };
  return el;
}

function dropTarget(el, to) {
  el.ondragover = (e) => { if (e.dataTransfer.types.includes('text/x-file')) { e.preventDefault(); el.classList.add('over'); } };
  el.ondragleave = (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); };
  el.ondrop = (e) => {
    e.preventDefault();
    el.classList.remove('over');
    const { path, from } = JSON.parse(e.dataTransfer.getData('text/x-file'));
    moveFile(path, from, to);
  };
}

function moveFile(path, from, to) {
  if (from === to) return;
  const cs = ship.d.commits;
  if (from >= 0) cs[from].files = cs[from].files.filter((p) => p !== path);
  if (to >= 0) cs[to].files.push(path);
  saveShip();
  renderShip();
}

function moveMenu(btn, path, from) {
  document.querySelector('.pop.mvpop')?.remove();
  const cs = ship.d.commits;
  const m = document.createElement('div');
  m.className = 'pop mvpop';
  m.innerHTML = cs.map((c, i) => i === from ? '' : `<button data-i="${i}"><i class="num">${i + 1}</i><span class="t">${esc(c.message || 'Untitled commit')}</span></button>`).join('')
    + `<button data-i="new"><i class="num">+</i>New commit</button>${from >= 0 ? '<button data-i="-1" class="dim">Leave out (stays uncommitted)</button>' : ''}`;
  const r = btn.getBoundingClientRect();
  Object.assign(m.style, { position: 'fixed', top: `${r.bottom + 4}px`, right: `${innerWidth - r.right}px` });
  document.body.appendChild(m);
  m.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    m.remove();
    if (b.dataset.i === 'new') { cs.push({ message: ship.s.jiraKey ? `${ship.s.jiraKey} ` : '', files: [] }); moveFile(path, from, cs.length - 1); return focusMsg(cs.length - 1); }
    moveFile(path, from, Number(b.dataset.i));
  };
  setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }));
}

function commitCard(c, i) {
  const node = document.createElement('div');
  node.className = 'node';
  const long = c.message.length > 72;
  node.innerHTML = `<i class="knot">${i + 1}</i><div class="cc">
    <div class="cch"><input class="msg" value="${esc(c.message)}" placeholder="One line, imperative" spellcheck="true">
      <span class="len ${long ? 'warn' : ''}">${c.message.length}</span>
      <button class="ghost icon xs" data-a="del" title="Remove commit; its files return to the list">✕</button></div>
    <div class="sfs"></div></div>`;
  const inp = node.querySelector('.msg');
  inp.oninput = () => {
    c.message = inp.value.replace(/\n/g, ' ');
    const l = node.querySelector('.len');
    l.textContent = c.message.length;
    l.classList.toggle('warn', c.message.length > 72);
    saveShip();
    updateGo();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); focusMsg(i + 1); } };
  node.querySelector('[data-a=del]').onclick = () => {
    const cs = ship.d.commits;
    if (i > 0) cs[i - 1].files.push(...c.files);
    cs.splice(i, 1);
    saveShip();
    renderShip();
  };
  const sfs = node.querySelector('.sfs');
  c.files.forEach((p) => sfs.appendChild(fileRow(p, i)));
  if (!c.files.length) sfs.innerHTML = '<div class="dropzone">Drag files here</div>';
  dropTarget(node.querySelector('.cc'), i);
  return node;
}

function looseCard(files) {
  const node = document.createElement('div');
  node.className = 'node loose';
  node.innerHTML = `<i class="knot">–</i><div class="cc"><div class="cch"><span class="m">Not in a commit</span><span class="dim">stays uncommitted</span></div><div class="sfs"></div></div>`;
  const sfs = node.querySelector('.sfs');
  files.forEach((f) => sfs.appendChild(fileRow(f.path, -1)));
  dropTarget(node.querySelector('.cc'), -1);
  return node;
}

function busyOverlay() {
  $('#sh-body').insertAdjacentHTML('afterbegin', `<div class="thinking"><span class="spin"></span>Reading the diff and this repo's history…</div>`);
  $$('#dbody .composer button, #sh-go, #sh-plan').forEach((b) => (b.disabled = true));
}

async function plan(note) {
  if (!ship || ship.busy) return;
  const id = ship.id;
  ship.busy = true;
  renderShip();
  try {
    const d = await api(`/ship/${id}/plan`, { method: 'POST', body: { note: note || '' } });
    if (ship?.id !== id) return;
    ship.d = reconcile({ ...ship.s, draft: d });
    ship.preview = false;
  } catch (e) { toast(esc(e.message), 'bad', 7000); }
  if (ship?.id === id) { ship.busy = false; renderShip(); }
}

async function runShip() {
  const { id, s, d } = ship;
  clearTimeout(ship.timer);
  for (const c of d.commits) {
    if (c.files.length && !c.message.trim()) return toast('Every commit needs a message.', 'bad');
  }
  let out;
  try { out = await api(`/ship/${id}/command`, { method: 'POST', body: d }); } catch (e) { return toast(esc(e.message), 'bad', 7000); }
  const label = (x) => {
    if (x.startsWith('git switch -c')) return ['branch', `Create branch <b>${esc(d.branch)}</b>`];
    if (x.startsWith('git branch -m')) return ['branch', `Rename branch to <b>${esc(d.branch)}</b>`];
    if (x.startsWith('git add')) return ['commit', esc(x.match(/commit -q -m '((?:[^']|'\\'')*)'/)?.[1].replace(/'\\''/g, "'") || 'Commit')];
    if (x.startsWith('git pull --rebase')) return ['branch', `Rebase onto the latest <b>${esc(s.baseName)}</b>`];
    if (x.startsWith('git push') && s.onMain) return ['ship', `Push straight to <b>${esc(s.baseName)}</b> on origin`];
    if (x.startsWith('git push')) return ['ship', `Push to <b>origin</b>`];
    return ['review', `Open <b>draft</b> PR into <b>${esc(s.baseName)}</b>`];
  };
  const ok = await confirmSheet({
    title: shipAction(s, d) + '?',
    body: `<ol class="steps-l">${out.steps.map((x) => { const [ic, txt] = label(x); return `<li><span class="si">${ICON[ic]}</span><span>${txt}</span></li>`; }).join('')}</ol>
      <p class="dim">Typed into the Shell tab of this task. Review it there, then press Enter.</p>`,
    ok: 'Type into Shell',
  });
  if (!ok) return;
  const tid = id;
  setTab('shell');
  setTimeout(() => send({ t: 'in', id: tid, kind: 'shell', data: out.cmd }), 700);
  toast('Typed into Shell. Press Enter to run it.', 'ok');
  // Watch for the result while the command runs.
  let n = 0;
  const iv = setInterval(async () => {
    if (++n > 40 || current !== tid) return clearInterval(iv);
    const st = await api(`/ship/${tid}`).catch(() => null);
    if (st && ship?.id === tid && sig(st) !== ship.sig) {
      ship.s = st; ship.sig = sig(st); ship.d = reconcile(st);
      if (ptabOf(cur()) === 'ship') renderShip();
      if (st.pr?.state === 'OPEN' && !st.files.length) clearInterval(iv);
    }
  }, 3000);
}

function skeletonPanel() {
  return '<div class="db"><div class="skel"><i></i><i></i><i></i></div></div>';
}

// Light refresh while a Changes or Ship tab is visible.
setInterval(async () => {
  const t = cur();
  if (!t || mode !== 'tasks' || $('#drawer').hidden || !document.hasFocus() || document.activeElement?.closest('#drawer')) return;
  const p = ptabOf(t);
  if (p !== 'changes' && p !== 'ship') return;
  const st = await api(`/ship/${t.id}`).catch(() => null);
  if (!st || current !== t.id) return;
  if (p === 'changes' && changes?.id === t.id && sig(st) !== changes.sig) loadChanges(true);
  if (p === 'ship' && ship?.id === t.id && !ship.busy && sig(st) !== ship.sig) {
    ship.s = st; ship.sig = sig(st);
    ship.d = reconcile({ ...st, draft: ship.d });
    renderShip();
  }
}, 4000);
