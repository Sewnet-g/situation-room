// PR list, Jira, ticket sheet, palette, and wiring. Loaded after app.js.

let prScope = store.get('prScope', 'review');
let prRepo = store.get('prRepo', null);
let jFilter = store.get('jFilter', 'forme');
let jSel = null;
let jIssues = [];
// Older builds stored a single project string.
let jProjects = [store.get('jProjects', [])].flat().filter(Boolean);
let jProjList = [];
let mineCache = [];
let prSel = null;
const TYPE_C = { Bug: 'bad', Story: 'ok', Epic: 'pur' };
const CAT_C = { new: '', indeterminate: 'blue', done: 'ok' };

const skeleton = (n = 5) => `<div class="rows-skel">${'<i></i>'.repeat(n)}</div>`;

// ---- Pull requests ----

async function loadPrView() {
  for (const b of $$('#prscope button')) b.classList.toggle('on', b.dataset.scope === prScope);
  $('#prrepos').hidden = prScope !== 'review';
  loadPrDetail();
  if (prScope === 'updates') return renderPrWatch();
  return prScope === 'mine' ? loadMine() : loadPrRepos();
}

// Row click shows the PR on the right; buttons and links on the row keep their own action.
function prRow(el, slug, number, action) {
  const key = `${slug.toLowerCase()}#${number}`;
  el.classList.add('pr');
  el.classList.toggle('sel', prSel?.key === key);
  el.onclick = (e) => {
    if (e.target.closest('button, a')) return;
    prSel = { key, slug, number, action };
    for (const r of $$('#prlist .row.pr')) r.classList.toggle('sel', r === el);
    loadPrDetail();
  };
  if (prSel?.key === key) prSel.action = action;
}

async function loadPrDetail() {
  const d = $('#prdetail');
  const sel = prSel;
  if (!sel) { d.innerHTML = '<div class="loading dim">Pick a pull request to read it.</div>'; return; }
  d.innerHTML = '<div class="loading">Loading pull request…</div>';
  let p;
  try { p = await api(`/prs/${sel.slug}/${sel.number}`); } catch (e) { if (prSel === sel) d.innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  if (prSel !== sel) return;
  const st = { APPROVED: 'ok', CHANGES_REQUESTED: 'bad' };
  d.innerHTML = `
    <div class="jh">
      <div class="crumbs"><span class="mono">${esc(sel.slug.split('/')[1])}#${p.number}</span> <span class="dim">·</span> <span class="mono">${esc(p.branch)}</span> <span class="dim">→ ${esc(p.base)}</span></div>
      <h2>${esc(p.title)}</h2>
      <div class="props">
        ${p.draft ? '<span class="tag">draft</span>' : ''}${p.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}
        <span class="dim">@${esc(p.author)}</span>
        <span class="dim">· opened ${ago(p.createdAt)}</span>
        <span class="mono"><span class="add">+${p.additions}</span> <span class="del">−${p.deletions}</span></span>
        <span class="dim">· ${plural(p.changedFiles, 'file')}</span>
      </div>
      ${p.reviews.length ? `<div class="props">${p.reviews.map((r) => `<span class="tag ${st[r.state] || ''}">@${esc(r.author)} ${esc(r.state.toLowerCase().replace('_', ' '))}</span>`).join('')}</div>` : ''}
      <div class="jact"><span id="pract"></span><a class="ghost btn" href="${esc(p.url)}">Open on GitHub <span class="ext">↗</span></a></div>
    </div>
    <div class="jdesc rich">${p.body?.trim() ? md(p.body) : '<p class="dim">No description.</p>'}</div>
    <div class="lbl">Files · ${p.files.length}</div>
    <div class="prfiles">${p.files.map((f) => `<div><span class="mono">${esc(f.path)}</span><span class="mono"><span class="add">+${f.add}</span> <span class="del">−${f.del}</span></span></div>`).join('')}</div>`;
  if (sel.action) $('#pract').replaceWith(sel.action());
}

function watchBadges(x) {
  return [x.comments && `<span class="tag blue">${plural(x.comments, 'comment')}</span>`,
    x.reviews && `<span class="tag pur">${plural(x.reviews, 'review')}</span>`,
    x.commits && `<span class="tag ok">${plural(x.commits, 'commit')}</span>`].filter(Boolean).join('');
}

function renderPrWatch() {
  if (prScope !== 'updates') {
    // Keep the dots on the other lists current without refetching.
    for (const el of $$('#prlist .row[data-key]')) {
      const x = prWatch.items.find((i) => i.key === el.dataset.key);
      el.classList.toggle('unread', !!x?.unread);
    }
    return;
  }
  const box = $('#prlist');
  const items = prWatch.items.filter((x) => x.unread).sort((a, b) => b.unread - a.unread);
  if (!prWatch.at) { box.innerHTML = skeleton(3); return; }
  if (!items.length) {
    box.innerHTML = emptyState('Caught up', `Watching ${plural(prWatch.items.length, 'open PR')} you own or review. New comments and commits from others land here.`)
      + `<p class="watchmeta">Checked ${ago(new Date(prWatch.at).toISOString())} · <button class="ghost xs" id="pw-poll">Check now</button></p>`;
    $('#pw-poll').onclick = pollNow;
    return;
  }
  box.innerHTML = `<div class="listhead"><span>${plural(items.length, 'PR')} with activity</span><span class="grow"></span>
    <span class="dim">checked ${ago(new Date(prWatch.at).toISOString())}</span>
    <button class="ghost xs" id="pw-poll">Check now</button><button class="ghost xs" id="pw-all">Mark all seen</button></div>`;
  $('#pw-poll').onclick = pollNow;
  $('#pw-all').onclick = () => items.forEach((x) => markPrSeen(x.key));
  for (const x of items) {
    const t = tasks.find((k) => prKey(k) === x.key);
    const el = document.createElement('div');
    el.className = 'row unread';
    el.dataset.key = x.key;
    el.innerHTML = `${x.role === 'author' ? `<span class="ico k-address">${ICON.address}</span>` : avatar(x.author || '?')}
      <div class="rt"><div class="r1"><b>${esc(x.title)}</b>${watchBadges(x)}</div>
      <div class="r2"><span class="mono">${esc(x.slug.split('/')[1])}#${x.number}</span> · ${x.role === 'author' ? 'yours' : `@${esc(x.author)}`}</div></div>
      <button class="ghost icon xs" title="Mark seen">✓</button>`;
    el.querySelector('button').onclick = (e) => { e.stopPropagation(); markPrSeen(x.key); };
    const open = document.createElement('button');
    open.className = 'primary';
    open.textContent = updateLabel(x, t);
    open.onclick = () => updateAction(x, t, open);
    el.appendChild(open);
    prRow(el, x.slug, x.number, () => { const c = open.cloneNode(true); c.onclick = () => updateAction(x, t, c); return c; });
    box.appendChild(el);
  }
}

const updateLabel = (x, t) => (x.role === 'author' ? (t ? 'Open task' : 'Work on feedback') : t ? 'Review update' : 'Review');

// Reviewer: re-review in the existing task, or start one. Author: open or start the feedback task.
async function updateAction(x, t, btn) {
  if (x.role === 'author') return t ? (markPrSeen(x.key), select(t.id)) : startPrTask('/address', { slug: x.slug, number: x.number }, btn);
  if (!t) return startPrTask('/review', { slug: x.slug, number: x.number }, btn);
  btn.disabled = true;
  try {
    await api(`/review/${t.id}/update`, { method: 'POST', body: { comments: x.comments, reviews: x.reviews, commits: x.commits } });
    tab = 'claude';
    select(t.id);
  } catch (e) { btn.disabled = false; toast(esc(e.message), 'bad', 7000); }
}

async function pollNow(e) {
  e.target.disabled = true;
  e.target.textContent = 'Checking…';
  await api('/prwatch/poll', { method: 'POST' }).catch((err) => toast(esc(err.message), 'bad'));
  renderPrWatch();
}

async function loadPrRepos() {
  const repos = await api('/prs').catch(() => []);
  if (prScope !== 'review') return;
  if (!prRepo || !repos.some((r) => r.slug === prRepo)) prRepo = repos[0]?.slug || null;
  const box = $('#prrepos');
  box.innerHTML = '';
  for (const r of repos) {
    const b = document.createElement('button');
    b.className = 'chip' + (r.slug === prRepo ? ' on' : '') + (r.path ? '' : ' warn');
    b.innerHTML = `<span class="own">${esc(r.slug.split('/')[0])}/</span>${esc(r.slug.split('/')[1])}<span class="x" title="Remove">✕</span>`;
    b.title = r.path ? tilde(r.path) : 'No local clone; reviews need one';
    b.onclick = async (e) => {
      if (e.target.classList.contains('x')) {
        if (!(await confirmSheet({ title: `Remove ${esc(r.slug)}?`, body: '<p>It disappears from this list. Nothing on disk changes.</p>', ok: 'Remove', danger: true }))) return;
        await api(`/prs/${r.slug}`, { method: 'DELETE' });
        return loadPrRepos();
      }
      prRepo = r.slug;
      store.set('prRepo', prRepo);
      loadPrRepos();
    };
    box.appendChild(b);
  }
  const add = document.createElement('form');
  add.className = 'chip add';
  add.innerHTML = '<input placeholder="+ owner/repo" spellcheck="false">';
  add.onsubmit = async (e) => {
    e.preventDefault();
    const slug = add.firstChild.value.trim();
    try { await api('/prs', { method: 'POST', body: { slug } }); } catch (err) { return toast(esc(err.message), 'bad'); }
    prRepo = slug.toLowerCase();
    store.set('prRepo', prRepo);
    loadPrRepos();
  };
  box.appendChild(add);
  loadPrs();
}

function prTags(p) {
  return [p.requested && '<span class="tag req">requested</span>', p.draft && '<span class="tag">draft</span>',
    p.decision === 'APPROVED' && '<span class="tag ok">approved</span>',
    p.decision === 'CHANGES_REQUESTED' && '<span class="tag bad">changes requested</span>'].filter(Boolean).join('');
}

async function loadPrs() {
  const box = $('#prlist');
  if (!prRepo) { box.innerHTML = emptyState('No repos', 'Add one as owner/repo above.'); return; }
  box.innerHTML = skeleton();
  let prs;
  try { prs = await api(`/prs/${prRepo}`); } catch (e) { box.innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  if (prScope !== 'review') return;
  const me = (mineCache[0]?.author || '').toLowerCase();
  prs = prs.filter((p) => p.author.toLowerCase() !== me);
  $('#n-prs').textContent = prs.filter((p) => p.requested && !p.taskId).length || '';
  if (!prs.length) { box.innerHTML = emptyState('All clear', 'No open PRs from others in this repo.'); return; }
  prs.sort((a, b) => (b.requested - a.requested) || b.updatedAt.localeCompare(a.updatedAt));
  box.innerHTML = '';
  for (const p of prs) {
    const el = document.createElement('div');
    el.className = 'row' + (p.requested ? ' hot' : '') + (watchOf(prRepo, p.number)?.unread ? ' unread' : '');
    el.dataset.key = `${prRepo.toLowerCase()}#${p.number}`;
    el.innerHTML = `${avatar(p.author)}<div class="rt"><div class="r1"><b>${esc(p.title)}</b>${prTags(p)}</div>
      <div class="r2"><span class="mono">#${p.number}</span> · @${esc(p.author)} · <span class="mono">${esc(p.branch)}</span> · ${ago(p.updatedAt)}</div></div>
      <a class="ghost icon btn" href="${esc(p.url)}" title="Open in browser">↗</a>`;
    const w = watchOf(prRepo, p.number);
    const t = p.taskId && tasks.find((k) => k.id === p.taskId);
    const act = (btn) => (w?.unread ? updateAction(w, t, btn) : p.taskId ? select(p.taskId) : startPrTask('/review', { slug: prRepo, number: p.number }, btn));
    const b = document.createElement('button');
    b.className = p.taskId && !w?.unread ? 'ghost' : 'primary';
    b.textContent = w?.unread ? updateLabel(w, t) : p.taskId ? 'Open' : 'Review';
    b.onclick = () => act(b);
    el.appendChild(b);
    prRow(el, prRepo, p.number, () => { const c = b.cloneNode(true); c.onclick = () => act(c); return c; });
    box.appendChild(el);
  }
}

async function loadMine() {
  const box = $('#prlist');
  box.innerHTML = skeleton(3);
  try { mineCache = await api('/mine'); } catch (e) { box.innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  if (prScope !== 'mine') return;
  if (!mineCache.length) { box.innerHTML = emptyState('No open PRs', 'PRs you open on GitHub show up here with their feedback.'); return; }
  box.innerHTML = '';
  for (const p of mineCache) {
    const el = document.createElement('div');
    el.className = 'row' + (p.unresolved ? ' hot' : '') + (watchOf(p.slug, p.number)?.unread ? ' unread' : '');
    el.dataset.key = `${p.slug.toLowerCase()}#${p.number}`;
    const fbk = p.unresolved ? `<span class="tag warn">${plural(p.unresolved, 'open thread')}</span>` : '';
    el.innerHTML = `<span class="ico k-address">${ICON.address}</span><div class="rt"><div class="r1"><b>${esc(p.title)}</b>${fbk}${prTags(p)}</div>
      <div class="r2"><span class="mono">${esc(p.slug.split('/')[1])}#${p.number}</span> · <span class="mono">${esc(p.branch)}</span> · ${ago(p.updatedAt)}</div></div>
      <a class="ghost icon btn" href="${esc(p.url)}" title="Open in browser">↗</a>`;
    const b = document.createElement('button');
    b.className = p.taskId ? 'ghost' : p.unresolved ? 'primary' : '';
    b.textContent = p.taskId ? 'Open' : 'Work on feedback';
    b.onclick = () => (p.taskId ? select(p.taskId) : startPrTask('/address', { slug: p.slug, number: p.number }, b));
    el.appendChild(b);
    prRow(el, p.slug, p.number, () => { const c = b.cloneNode(true); c.onclick = () => (p.taskId ? select(p.taskId) : startPrTask('/address', { slug: p.slug, number: p.number }, c)); return c; });
    box.appendChild(el);
  }
}

async function startPrTask(route, body, btn) {
  const review = route === '/review';
  // Feedback on your own PR goes to the task that made the branch when there is one; no new agent to pick.
  if (!review) {
    const o = await api(`/address/owner?slug=${encodeURIComponent(body.slug)}&number=${body.number}`).catch(() => ({}));
    if (o.id) {
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const t = await api(route, { method: 'POST', body });
        toast(`Feedback sent to <b>${esc(o.name)}</b>, the task that made this branch.`, 'ok', 6000);
        tab = 'claude'; drawerOpen = true; store.set('drawer', '1'); store.set('ptab:task', 'feedback'); select(t.id);
      } catch (e) { btn.disabled = false; btn.textContent = 'Retry'; toast(esc(e.message), 'bad', 7000); }
      return;
    }
  }
  const choice = await startSheet({
    title: `${review ? 'Review' : 'Address feedback on'} #${body.number}`,
    sub: esc(review ? 'Checks the PR out in its own worktree and drafts a review.' : 'Works on the PR branch and drafts replies to the open threads.'),
    repo: body.slug, ok: review ? 'Start review' : 'Start',
  });
  if (!choice) return;
  btn.disabled = true;
  btn.textContent = 'Checking out…';
  try {
    const t = await api(route, { method: 'POST', body: { ...body, ...choice, repoPath: undefined } });
    tab = 'claude';
    drawerOpen = true;
    store.set('drawer', '1');
    select(t.id);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Retry';
    toast(esc(e.message), 'bad', 7000);
  }
}

// ---- Jira ----

async function loadJira(keepSel) {
  for (const b of $$('#jfilter button')) b.classList.toggle('on', b.dataset.f === jFilter);
  const box = $('#jlist');
  if (!jIssues.length || !keepSel) box.innerHTML = skeleton(6);
  const want = `${jFilter}|${jProjects.join(',')}`;
  let r;
  try { r = await api(`/jira/issues?filter=${jFilter}&projects=${encodeURIComponent(jProjects.join(','))}`); } catch (e) { box.innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  if (want !== `${jFilter}|${jProjects.join(',')}`) return;
  jIssues = Array.isArray(r) ? r : r.issues;
  jProjList = r.projects || [];
  if (jFilter === 'forme' && !jProjects.length) $('#n-jira').textContent = jIssues.filter((i) => i.mine && i.cat === 'new' && !i.taskId).length || '';
  renderJiraProjects();
  renderJiraList();
  const vis = visibleIssues();
  if (!vis.some((i) => i.key === jSel)) jSel = vis[0]?.key || null;
  jSel ? loadIssue(jSel) : ($('#jdetail').innerHTML = emptyState('Nothing here', 'No open tickets match this filter.'));
}

function renderJiraProjects() {
  const box = $('#jprojects');
  // Keep selected projects visible even when the current filter has none of them.
  const all = [...jProjList];
  for (const k of jProjects) if (!all.some((p) => p.key === k)) all.push({ key: k, name: k, n: 0 });
  box.hidden = all.length < 2 && !jProjects.length;
  const total = jProjList.reduce((a, p) => a + p.n, 0);
  box.innerHTML = `<button class="chip ${jProjects.length ? '' : 'on'}" data-k="">All projects<span class="n">${total}</span></button>
    <span class="vsep"></span>`
    + all.map((p) => `<button class="chip proj ${jProjects.includes(p.key) ? 'on' : ''}" data-k="${esc(p.key)}" title="${esc(p.name)}">
      <b class="mono">${esc(p.key)}</b><span class="pn">${esc(p.name === p.key ? '' : p.name)}</span><span class="n">${p.n}</span></button>`).join('');
  for (const b of $$('button', box)) b.onclick = () => {
    const k = b.dataset.k;
    jProjects = !k ? [] : jProjects.includes(k) ? jProjects.filter((x) => x !== k) : [...jProjects, k];
    store.set('jProjects', jProjects);
    renderJiraProjects();
    loadJira(true);
  };
}

function visibleIssues() {
  const q = $('#jq').value.trim().toLowerCase();
  if (!q) return jIssues;
  return jIssues.filter((i) => `${i.key} ${i.summary} ${i.assignee || ''} ${i.status}`.toLowerCase().includes(q));
}

function renderJiraList() {
  const box = $('#jlist');
  const list = visibleIssues();
  const q = $('#jq').value.trim();
  if (!list.length) {
    box.innerHTML = q ? emptyState('No matches', `Nothing here matches “${esc(q)}”.`) : emptyState('Inbox zero', 'No open tickets match this filter.');
    return;
  }
  box.innerHTML = '';
  for (const i of list) {
    const el = document.createElement('div');
    el.className = 'row j' + (i.key === jSel ? ' sel' : '');
    el.innerHTML = `<span class="tkind ${TYPE_C[i.type] || ''}" title="${esc(i.type)}">${esc((i.type.match(/[A-Za-z]/) || ["?"])[0])}</span>
      <div class="rt"><div class="r1"><b>${esc(i.summary)}</b></div>
      <div class="r2"><span class="mono">${esc(i.key)}</span> · <span class="st ${CAT_C[i.cat] || ''}">${esc(i.status)}</span>${i.mine ? '' : i.assignee ? ` · ${esc(i.assignee)}` : ' · unassigned'} · ${ago(i.updated)}</div></div>
      ${i.taskId ? '<span class="tag ok">task</span>' : ''}`;
    el.onclick = () => { jSel = i.key; renderJiraList(); loadIssue(i.key); };
    box.appendChild(el);
  }
}

async function loadIssue(key) {
  const d = $('#jdetail');
  d.innerHTML = '<div class="loading">Loading ticket…</div>';
  let i;
  try { i = await api(`/jira/issue/${key}`); } catch (e) { d.innerHTML = `<div class="loading err">${esc(e.message)}</div>`; return; }
  if (jSel !== key) return;
  const repos = await api('/repos').catch(() => []);
  const def = config.jiraRepos?.[i.project];
  d.innerHTML = `
    <div class="jh">
      <div class="crumbs"><span class="mono">${esc(i.key)}</span>${i.epic ? ` <span class="dim">in</span> ${esc(i.epic.summary || i.epic.key)}` : ''}</div>
      <h2>${esc(i.summary)}</h2>
      <div class="props">
        <span class="tag ${TYPE_C[i.type] || ''}">${esc(i.type)}</span>
        <span class="st ${CAT_C[i.cat] || ''}">${esc(i.status)}</span>
        ${i.priority ? `<span class="dim">${esc(i.priority)}</span>` : ''}
        <span class="dim">· ${esc(i.assignee || 'Unassigned')}</span>
        <span class="dim">· updated ${ago(i.updated)}</span>
      </div>
      <div class="jact">
        ${i.taskId ? '<button class="primary" id="jopen">Open task</button>' : `
        <button class="primary" id="jstart">Start task</button>`}
        <a class="ghost btn" href="${esc(i.url)}">Open in Jira <span class="ext">↗</span></a>
      </div>
    </div>
    <div class="jdesc rich">${i.html ? cleanHtml(i.html) : '<p class="dim">No description.</p>'}</div>
    ${i.comments.length ? `<div class="lbl">Comments · ${i.comments.length}</div>${i.comments.map((c) => `
      <div class="msg">${avatar(c.author || '?')}<div class="mb"><div class="mh"><b>${esc(c.author)}</b><span class="dim">${ago(c.at)}</span></div>
      <div class="rich">${cleanHtml(c.html)}</div></div></div>`).join('')}` : ''}`;
  if (i.taskId) $('#jopen').onclick = () => select(i.taskId);
  else $('#jstart').onclick = async (e) => {
    const choice = await startSheet({ title: `Start ${esc(i.key)}`, sub: esc(i.summary), repos, repo: def });
    if (!choice) return;
    e.target.disabled = true;
    e.target.textContent = 'Branching off main…';
    try {
      const body = { key: i.key, ...choice };
      let t = await api('/jira/start', { method: 'POST', body });
      if (t.needsReassign) {
        const ok = await confirmSheet({ title: `${esc(i.key)} is assigned to ${esc(t.assignee)}`, body: `<p>Starting assigns it to you instead and moves it to In Progress.</p>`, ok: 'Assign to me and start' });
        if (!ok) { e.target.disabled = false; e.target.textContent = 'Start task'; return; }
        e.target.textContent = 'Branching off main…';
        t = await api('/jira/start', { method: 'POST', body: { ...body, reassign: true } });
      }
      if (t.jiraError) toast(esc(t.jiraError), 'bad', 9000);
      tab = 'claude';
      select(t.id);
    } catch (err) { e.target.disabled = false; e.target.textContent = 'Start task'; toast(esc(err.message), 'bad', 7000); }
  };
}

// ---- New ticket (AI drafted, human confirmed) ----

async function newTicket() {
  const proj = config.jiraProject || '';
  const f = { idea: '', project: proj, type: 'Task', epic: '', assignToMe: true, summary: '', description: '' };
  const box = $('#tform');
  box.innerHTML = `<h3>New ticket</h3>
    <div class="steps"><span class="on">1 Describe</span><span>2 Review draft</span><span>3 Create</span></div>
    <label>What needs doing? <textarea id="tk-idea" rows="4" placeholder="Rough notes are fine: the problem, where it is, what done looks like."></textarea></label>
    <div class="grid3">
      <label>Project <input id="tk-proj" value="${esc(proj)}" spellcheck="false"></label>
      <label>Type <select id="tk-type"><option>Task</option></select></label>
      <label>Epic <select id="tk-epic"><option value="">None</option></select></label>
    </div>
    <div id="tk-draft" hidden>
      <label>Summary <input id="tk-sum" maxlength="120"></label>
      <div class="split">
        <label>Description <span class="dim">(Jira wiki markup)</span><textarea id="tk-desc" rows="12" class="mono"></textarea></label>
        <div><div class="lbl">Preview</div><div id="tk-prev" class="rich prev"></div></div>
      </div>
      <div class="ask"><input id="tk-refine" placeholder="Refine: e.g. split the done-when list, mention the Helm chart"><button class="ghost xs" id="tk-redo">${ICON.spark} Redraft</button></div>
    </div>
    <p id="tk-err" class="err"></p>
    <menu>
      <label class="check"><input type="checkbox" id="tk-me" checked> Assign to me</label>
      <span class="grow"></span>
      <button class="ghost" id="tk-cancel">Cancel</button>
      <button class="primary" id="tk-go">${ICON.spark} Draft with AI</button>
    </menu>`;
  $('#tdlg').showModal();
  autogrow($('#tk-idea'));
  $('#tk-idea').focus();
  const meta = async () => {
    const m = await api(`/jira/meta?project=${encodeURIComponent($('#tk-proj').value.trim())}`).catch(() => ({ types: [], epics: [] }));
    $('#tk-type').innerHTML = (m.types.length ? m.types : ['Task']).map((t) => `<option>${esc(t)}</option>`).join('');
    $('#tk-epic').innerHTML = '<option value="">None</option>' + m.epics.map((e) => `<option value="${esc(e.key)}">${esc(e.key)} · ${esc(e.summary)}</option>`).join('');
  };
  meta();
  $('#tk-proj').onchange = meta;
  $('#tk-cancel').onclick = () => $('#tdlg').close();
  const step = (n) => $$('.steps span', box).forEach((s, i) => s.classList.toggle('on', i < n));
  const prev = () => { $('#tk-prev').innerHTML = wiki($('#tk-desc').value); };
  $('#tk-desc').oninput = prev;
  const read = () => Object.assign(f, {
    idea: $('#tk-idea').value.trim(), project: $('#tk-proj').value.trim(), type: $('#tk-type').value,
    epic: $('#tk-epic').value, assignToMe: $('#tk-me').checked, summary: $('#tk-sum').value.trim(), description: $('#tk-desc').value,
  });
  const draft = async (note) => {
    read();
    if (!f.idea) return ($('#tk-err').textContent = 'Describe the work first.');
    $('#tk-err').textContent = '';
    const go = $('#tk-go');
    go.disabled = true;
    $('#tk-redo').disabled = true;
    go.innerHTML = '<span class="spin"></span> Drafting…';
    try {
      const epicName = f.epic ? $('#tk-epic').selectedOptions[0].textContent : '';
      const d = await api('/jira/draft', {
        method: 'POST',
        body: { idea: note ? `${f.idea}\n\nRefinement: ${note}` : f.idea, project: f.project, type: f.type, epic: epicName, current: f.summary ? f : null },
      });
      $('#tk-sum').value = d.summary;
      $('#tk-desc').value = d.description;
      $('#tk-draft').hidden = false;
      $('#tk-refine').value = '';
      prev();
      step(2);
      go.innerHTML = 'Create ticket…';
      go.onclick = create;
    } catch (e) { $('#tk-err').textContent = e.message; go.innerHTML = `${ICON.spark} Draft with AI`; }
    go.disabled = false;
    $('#tk-redo').disabled = false;
  };
  const create = async () => {
    read();
    if (!f.summary) return ($('#tk-err').textContent = 'Summary is required.');
    const ok = await confirmSheet({
      title: `Create in ${esc(f.project)}?`,
      body: `<p>A ${esc(f.type)}${f.epic ? ` under ${esc(f.epic)}` : ''}, visible to the team${f.assignToMe ? ', assigned to you' : ''}.</p><blockquote>${esc(f.summary)}</blockquote>`,
      ok: 'Create ticket',
    });
    if (!ok) return;
    step(3);
    try {
      const r = await api('/jira/create', { method: 'POST', body: f });
      $('#tdlg').close();
      toast(`Created <a href="${esc(r.url)}">${esc(r.key)} ↗</a>`, 'ok', 7000);
      jSel = r.key;
      if (mode === 'jira') loadJira(true);
    } catch (e) { $('#tk-err').textContent = e.message; step(2); }
  };
  $('#tk-go').onclick = () => draft();
  $('#tk-redo').onclick = () => draft($('#tk-refine').value.trim() || 'Improve it.');
  $('#tk-refine').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#tk-redo').click(); } };
}

// Enough Jira wiki markup to preview a draft.
function wiki(src) {
  const out = [];
  let list = false;
  for (const l of String(src).split('\n')) {
    const inl = (s) => esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\{\{([^}]+)\}\}/g, '<code>$1</code>').replace(/_([^_\n]+)_/g, '<i>$1</i>');
    const li = l.match(/^\s*[*#-]+\s+(.*)/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inl(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    const h = l.match(/^h([1-6])\.\s*(.*)/);
    if (h) out.push(`<h4>${inl(h[2])}</h4>`);
    else if (l.trim()) out.push(`<p>${inl(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

// ---- Command palette ----

function palette() {
  const d = $('#palette');
  const actions = [
    { label: 'New task', hint: '⌘N', run: newTask },
    { label: 'Pull requests to review', hint: '⌘P', run: () => { prScope = 'review'; store.set('prScope', 'review'); setMode('prs'); } },
    { label: 'My pull requests', run: () => { prScope = 'mine'; store.set('prScope', 'mine'); setMode('prs'); } },
    { label: 'PR updates', sub: 'New comments and commits', run: () => { prScope = 'updates'; store.set('prScope', 'updates'); setMode('prs'); } },
    { label: 'Jira tickets', hint: '⌘J', run: () => setMode('jira') },
    { label: 'New Jira ticket', run: () => { setMode('jira'); newTicket(); } },
  ];
  const items = () => [
    ...shown().map((t) => ({ label: t.name, sub: t.label || t.repo, icon: ICON[kindOf(t)], status: t.status, run: () => select(t.id) })),
    ...(hooks.work() ? actions.filter((a) => config.jira || !/Jira/.test(a.label)) : actions.slice(0, 1)).map((a) => ({ ...a, icon: '›' })),
    ...(hooks.work() ? jIssues : []).map((i) => ({ label: i.summary, sub: i.key, icon: ICON.jira, run: () => { jSel = i.key; setMode('jira'); } })),
  ];
  let sel = 0;
  let res = [];
  const draw = () => {
    const q = $('#pq').value.trim().toLowerCase();
    res = items().filter((x) => !q || `${x.label} ${x.sub || ''}`.toLowerCase().includes(q)).slice(0, 12);
    sel = Math.min(sel, Math.max(0, res.length - 1));
    $('#pres').innerHTML = res.map((x, i) => `<div class="pi${i === sel ? ' on' : ''}" data-i="${i}"><span class="pic">${x.icon}</span>
      <span class="pl">${esc(x.label)}</span>${x.status && LABEL[x.status] ? `<i class="dot ${x.status}"></i>` : ''}
      <span class="ps">${esc(x.sub || '')}</span>${x.hint ? `<kbd>${x.hint}</kbd>` : ''}</div>`).join('') || '<div class="pe">No matches</div>';
    $$('#pres .pi').forEach((el) => (el.onclick = () => pick(+el.dataset.i)));
  };
  const pick = (i) => { const x = res[i]; d.close(); x?.run(); };
  $('#pq').value = '';
  $('#pq').oninput = () => { sel = 0; draw(); };
  $('#pq').onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + res.length) % (res.length || 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
  };
  draw();
  d.showModal();
  $('#pq').focus();
}

// ---- Wiring ----

$('#new').onclick = newTask;
for (const b of $$('#modes button')) b.onclick = () => setMode(b.dataset.mode);
for (const b of $$('#tabs button')) b.onclick = () => setTab(b.dataset.tab);
for (const b of $$('#prscope button')) b.onclick = () => { prScope = b.dataset.scope; store.set('prScope', prScope); loadPrView(); };
for (const b of $$('#jfilter button')) b.onclick = () => { jFilter = b.dataset.f; store.set('jFilter', jFilter); loadJira(); };
for (const b of $$('#empty [data-go]')) b.onclick = () => (b.dataset.go === 'new' ? newTask() : setMode(b.dataset.go));
$('#prrefresh').onclick = loadPrView;
$('#jrefresh').onclick = () => loadJira(true);
$('#jnew').onclick = newTicket;
$('#jq').oninput = () => { $('#jsearch').classList.toggle('on', !!$('#jq').value); renderJiraList(); };
$('#jq').onkeydown = (e) => {
  if (e.key === 'Escape') { e.target.value = ''; $('#jq').oninput(); e.target.blur(); }
  if (e.key === 'Enter') { const i = visibleIssues()[0]; if (i) { jSel = i.key; renderJiraList(); loadIssue(i.key); } }
};
$('#reviewbtn').onclick = toggleDrawer;
$('#q').oninput = renderSidebar;
$('#q').onkeydown = (e) => { if (e.key === 'Escape') { e.target.value = ''; renderSidebar(); e.target.blur(); } };
$('#more').onclick = (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
document.addEventListener('click', () => ($('#menu').hidden = true));
$('#restart').onclick = () => {
  const x = terms.get(`${current}:${tab}`);
  if (x) x.attached = false;
  send({ t: 'restart', id: current, kind: tab === 'diff' ? 'claude' : tab });
  setTimeout(show, 300);
};
$('#remove').onclick = async () => {
  const t = cur();
  if (!t) return;
  const r = await api(`/tasks/${t.id}/risk`).catch(() => ({ worktree: false, risk: [] }));
  const body = !r.worktree ? '<p>The session ends. The branch stays.</p>'
    : r.risk.length ? `<p>The worktree <span class="mono">${esc(tilde(r.cwd))}</span> has <b>${esc(r.risk.join(' and '))}</b>.</p>
        <label class="row"><input type="checkbox" id="rm-force"> Delete the worktree anyway</label><p class="dim">Unticked keeps the worktree on disk.</p>`
    : `<p>The session ends and the worktree <span class="mono">${esc(tilde(r.cwd))}</span> is deleted. Nothing is lost; the branch stays.</p>`;
  // The sheet is gone once it resolves, so track the box as it changes.
  let force = false;
  const onChange = (e) => { if (e.target.id === 'rm-force') force = e.target.checked; };
  document.addEventListener('change', onChange);
  const ok = await confirmSheet({ title: `Remove “${esc(t.name)}”?`, body, ok: 'Remove task', danger: true });
  document.removeEventListener('change', onChange);
  if (!ok) return;
  await api(`/tasks/${t.id}?worktree=${!r.risk.length || force ? 1 : 0}&force=${force ? 1 : 0}`, { method: 'DELETE' });
};

// Every external link opens in the default browser.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || !/^https?:/.test(a.href)) return;
  e.preventDefault();
  window.sr?.open ? window.sr.open(a.href) : window.open(a.href);
});

// Capture phase so shortcuts work while a terminal has focus.
window.addEventListener('keydown', (e) => {
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();
  const go = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
  if (e.shiftKey && ['1', '2', '3', '!', '@', '#'].includes(e.key)) {
    return go(() => setTab({ 1: 'claude', '!': 'claude', 2: 'shell', '@': 'shell', 3: 'diff', '#': 'diff' }[e.key]));
  }
  if (e.shiftKey) return;
  if (k === 'n') go(newTask);
  else if (k === 'k') go(palette);
  else if (k === 't') go(() => setMode('tasks'));
  else if (k === 'p' && hooks.work()) go(() => setMode('prs'));
  else if (k === 'j' && hooks.work() && config.jira) go(() => setMode('jira'));
  else if (k === 'f' && mode === 'tasks') go(() => $('#q').focus());
  else if (k === 'f' && mode === 'jira') go(() => $('#jq').select());
  else if (k === 'e') go(toggleDrawer);
  else if (k === 'u') go(usageSheet);
  else if (k === 'b') go(toggleSidebar);
  else if (/^[1-9]$/.test(k)) {
    const t = ordered()[Number(k) - 1];
    if (t) go(() => select(t.id));
  } else if (k === 'arrowdown' || k === 'arrowup') {
    const o = ordered();
    const i = o.findIndex((t) => t.id === current);
    const t = o[(i + (k === 'arrowdown' ? 1 : -1) + o.length) % o.length];
    if (t) go(() => select(t.id));
  }
}, true);

// Sidebar width: drag the edge (220–520px), double-click to reset, ⌘B to hide. Remembered per viewer.
const SIDE = { min: 220, max: 520, dflt: 268 };
function setSide(w) {
  w = Math.round(Math.min(SIDE.max, Math.max(SIDE.min, w)));
  document.body.style.setProperty('--side', `${w}px`);
  return w;
}
function toggleSidebar() {
  const hidden = document.body.classList.toggle('side-hidden');
  store.set('sideHidden', hidden ? '1' : '');
  refit();
}
setSide(Number(store.get('side', SIDE.dflt)) || SIDE.dflt);
if (store.get('sideHidden', '') === '1') document.body.classList.add('side-hidden');
$('#sidegrip').onpointerdown = (e) => {
  if (document.body.classList.contains('side-hidden')) return toggleSidebar();
  e.preventDefault();
  const grip = e.currentTarget, x0 = e.clientX, w0 = $('#sidebar').offsetWidth;
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('side-drag');
  let w = w0;
  grip.onpointermove = (m) => { w = setSide(w0 + m.clientX - x0); refit(); };
  grip.onpointerup = () => { grip.onpointermove = grip.onpointerup = null; document.body.classList.remove('side-drag'); store.set('side', String(w)); refit(); };
};
$('#sidegrip').ondblclick = () => { store.set('side', String(setSide(SIDE.dflt))); refit(); };

window.addEventListener('resize', refit);
window.addEventListener('focus', () => current && send({ t: 'seen', id: current }));

api('/config').then((c) => { config = c; if (typeof initSpaces === 'function') initSpaces(); }).catch(() => {}).finally(() => {
  connect();
  setMode(mode);
  setInterval(refreshUsage, 5000);
  refreshUsage();
  // Keep the sidebar counts fresh while on other views.
  setTimeout(() => api('/mine').then((m) => (mineCache = m)).catch(() => {}), 1500);
});
