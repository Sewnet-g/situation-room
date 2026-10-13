// Spaces from config.spaces, cycled with ⌘⇧. — each shows only its own tasks; non-work spaces hide PRs and Jira.

let space = store.get('space', '');
const spaceDef = () => config.spaces?.[space] || null;
const inSpace = (t) => (t.space || '') === space;

Object.assign(hooks, {
  visible: inSpace,
  newTask: () => (space ? { space } : {}),
  roots: () => spaceDef()?.roots || config.roots,
  work: () => !space,
  // A task from another space never shows its name, and the dock badge counts only this space.
  notify: (t, title, body) => (inSpace(t) ? [title, body] : ['Situation Room', 'A task needs you']),
  badge: inSpace,
  pi: () => !spaceDef()?.login,
  login: (t) => !!config.spaces?.[t.space]?.login,
  allowMain: () => !!spaceDef()?.allowMain,
});

function applySpace(switched) {
  const sp = spaceDef();
  document.body.classList.toggle('space-alt', !!sp);
  for (const b of $$('#modes button, #empty [data-go]')) if (!['tasks', 'new'].includes(b.dataset.mode || b.dataset.go)) b.hidden = !!sp || (b.dataset.mode === 'jira' || b.dataset.go === 'jira') && !config.jira;
  $('#empty h2').textContent = sp ? `${sp.label}` : 'Every task, one window.';
  $('#empty p').textContent = sp ? 'Hidden from your other spaces. ⌘⇧. switches.' : config.jira ? 'Pick a task, review a PR, or start from a ticket.' : 'Pick a task or review a PR.';
  $('.brand').lastChild.textContent = sp ? sp.label : 'Situation Room';
  $('#q').placeholder = sp ? `Filter ${sp.label.toLowerCase()} tasks` : 'Filter tasks';
  $('#form').repo.placeholder = sp ? `A folder in ${tilde(sp.roots[0] || '~')}, or Browse…` : 'repo name, owner/repo or ~/some/dir';
  // Each space keeps its own selected task; on load the task list has not arrived yet.
  if (switched) {
    const keep = store.get(`current:${space}`, null);
    current = shown().some((t) => t.id === keep) ? keep : null;
    store.set('current', current || '');
  }
  if (sp && mode !== 'tasks') setMode('tasks');
  renderSidebar();
  if (mode === 'tasks') show();
  refreshUsage();
}

function nextSpace() {
  const all = ['', ...Object.keys(config.spaces || {})];
  store.set(`current:${space}`, current || '');
  space = all[(all.indexOf(space) + 1) % all.length];
  store.set('space', space);
  applySpace(true);
}

function initSpaces() {
  if (space && !config.spaces?.[space]) space = '';
  window.addEventListener('keydown', (e) => {
    if (e.metaKey && e.shiftKey && (e.key === '.' || e.key === '>' || e.code === 'Period')) { e.preventDefault(); e.stopPropagation(); nextSpace(); }
  }, true);
  applySpace();
}
