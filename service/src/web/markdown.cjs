const { esc } = require('./html.cjs');
const { inline } = require('./markdown-inline.cjs');
const { ITEM, isTable, table, list, mark, cls } = require('./markdown-blocks.cjs');

const FENCE = /^\s*(```+|~~~+)/;
const HEADING = /^ {0,3}(#{1,6})\s(.*)$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^ {0,3}> ?/;
const MAX_QUOTES = 4;

function fence(lines, start, env) {
  const close = lines[start].match(FENCE)[1].slice(0, 3);
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith(close)) end++;
  const code = lines.slice(start + 1, end).map(esc).join('\n');
  const changed = env.isChanged(start, end + 1);
  return { html: `<pre tabindex="0"${cls(changed)}><code>${mark(code, changed)}</code></pre>`, next: end + 1 };
}

function headingText(raw) {
  const text = raw.trim();
  let end = text.length;
  while (text[end - 1] === '#') end--;
  return end > 0 && end < text.length && /\s/.test(text[end - 1]) ? text.slice(0, end).trimEnd() : text;
}

function heading(lines, at, env) {
  const [, marks, text] = lines[at].match(HEADING);
  const level = Math.min(6, marks.length + env.base - 1);
  const changed = env.isChanged(at, at + 1);
  return { html: `<h${level}${cls(changed)}>${mark(inline(headingText(text), env.kindTag), changed)}</h${level}>`, next: at + 1 };
}

function quote(lines, start, env) {
  let at = start;
  while (at < lines.length && QUOTE.test(lines[at])) at++;
  const inner = lines.slice(start, at).map(line => line.replace(QUOTE, ''));
  const isChanged = (from, to) => env.isChanged(start + from, start + to);
  return { html: `<blockquote>${blocks(inner, { ...env, isChanged, quotes: env.quotes + 1 })}</blockquote>`, next: at };
}

function startsBlock(lines, at, env) {
  const line = lines[at];
  return !line.trim() || FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || (env.quotes < MAX_QUOTES && QUOTE.test(line)) || isTable(lines, at);
}

function paragraph(lines, start, env) {
  let at = start + 1;
  while (at < lines.length && !startsBlock(lines, at, env)) at++;
  const text = lines.slice(start, at).map(line => inline(line.trim(), env.kindTag)).join('<br>');
  const changed = env.isChanged(start, at);
  return { html: `<p${cls(changed)}>${mark(text, changed)}</p>`, next: at };
}

function blockAt(lines, at, env) {
  const line = lines[at];
  if (FENCE.test(line)) return fence(lines, at, env);
  if (HEADING.test(line)) return heading(lines, at, env);
  if (RULE.test(line)) return { html: '<hr>', next: at + 1 };
  if (env.quotes < MAX_QUOTES && QUOTE.test(line)) return quote(lines, at, env);
  if (isTable(lines, at)) return table(lines, at, env);
  if (ITEM.test(line)) return list(lines, at, env);
  return paragraph(lines, at, env);
}

function blocks(lines, env) {
  const out = [];
  let at = 0;
  while (at < lines.length) {
    if (!lines[at].trim()) {
      at++;
      continue;
    }
    const block = blockAt(lines, at, env);
    out.push(block.html);
    at = block.next;
  }
  return out.join('\n');
}

const splitLines = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

function renderMarkdown(source, { changed = new Set(), kindTag = () => '', base = 2 } = {}) {
  const isChanged = (from, to) => {
    for (let i = from; i < to; i++) if (changed.has(i)) return true;
    return false;
  };
  return blocks(splitLines(source), { isChanged, kindTag, base, quotes: 0 });
}

module.exports = { renderMarkdown, splitLines };
