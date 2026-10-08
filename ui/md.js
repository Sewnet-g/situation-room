// Small GitHub-flavoured markdown renderer for review comments, plus an HTML cleaner for Jira.
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])[_*]([^_*]+)[_*](?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>')
    .replace(/(^|\s)@([\w-]+)/g, '$1<span class="at">@$2</span>');
}

function md(text) {
  const out = [];
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = l.match(/^```\s*([\w-]*)/);
    if (fence) {
      close();
      const body = [];
      while (++i < lines.length && !/^```/.test(lines[i])) body.push(lines[i]);
      out.push(fence[1] === 'suggestion'
        ? `<div class="sugg"><div class="sugg-h">Suggested change</div><pre>${body.map((b) => `<span class="add">${esc(b) || ' '}</span>`).join('')}</pre></div>`
        : `<pre class="code">${esc(body.join('\n'))}</pre>`);
      continue;
    }
    const li = l.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (li) {
      const kind = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${mdInline(li[2])}</li>`);
      continue;
    }
    close();
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) out.push(`<h${h[1].length + 2}>${mdInline(h[2])}</h${h[1].length + 2}>`);
    else if (/^>\s?/.test(l)) out.push(`<blockquote>${mdInline(l.replace(/^>\s?/, ''))}</blockquote>`);
    else if (l.trim()) out.push(`<p>${mdInline(l)}</p>`);
  }
  close();
  return out.join('');
}

function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,link,meta').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
    }
  });
  return doc.body.firstChild.innerHTML;
}
