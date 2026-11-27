const { inline } = require('./markdown-inline.cjs');

const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE_CELL = /^:?-+:?$/;

const mark = (html, changed) => (changed ? `<ins>${html}</ins>` : html);
const cls = changed => (changed ? ' class="changed"' : '');

function cellsOf(line) {
  const cells = line.trim().replace(/^\|/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  if (cells.length > 1 && cells.at(-1) === '') cells.pop();
  return cells;
}

const isRuleRow = line => line.includes('|') && cellsOf(line).every(cell => RULE_CELL.test(cell));
const isTable = (lines, at) => lines[at].includes('|') && isRuleRow(lines[at + 1] ?? '');

function table(lines, start, env) {
  const head = cellsOf(lines[start]);
  let at = start + 2;
  const rows = [];
  while (at < lines.length && lines[at].includes('|')) {
    const changed = env.isChanged(at, at + 1);
    const cells = cellsOf(lines[at]);
    const tds = head.map((_, i) => `<td>${mark(inline(cells[i] ?? '', env.kindTag), changed && cells[i])}</td>`).join('');
    rows.push(`<tr${cls(changed)}>${tds}</tr>`);
    at++;
  }
  const ths = head.map(cell => `<th scope="col">${inline(cell, env.kindTag)}</th>`).join('');
  const headRow = `<tr${cls(env.isChanged(start, start + 1))}>${ths}</tr>`;
  const html = `<div class="table" tabindex="0" role="region" aria-label="Bảng"><table><thead>${headRow}</thead><tbody>${rows.join('')}</tbody></table></div>`;
  return { html, next: at };
}

function readItems(lines, start) {
  const items = [];
  let at = start;
  while (at < lines.length) {
    const match = lines[at].match(ITEM);
    if (match) {
      items.push({ indent: match[1].replace(/\t/g, '    ').length, ordered: /\d/.test(match[2]), number: parseInt(match[2], 10), text: [match[3]], from: at, to: at + 1, children: [] });
    } else if (!lines[at].trim()) {
      const next = lines[at + 1] ?? '';
      const again = next.match(ITEM);
      if (!again || (!again[1] && /\d/.test(again[2]) !== items[0].ordered)) break;
    } else if (/^\s+/.test(lines[at]) && !/^\s*(?:```|~~~)/.test(lines[at])) {
      items.at(-1).text.push(lines[at].trim());
      items.at(-1).to = at + 1;
    } else break;
    at++;
  }
  return { items, next: at };
}

function nest(items) {
  const root = { indent: -1, children: [], depth: 0 };
  const stack = [root];
  for (const item of items) {
    while (stack.length > 1 && item.indent <= stack.at(-1).indent) stack.pop();
    if (stack.length > 8) stack.pop();
    stack.at(-1).children.push(item);
    stack.push(item);
  }
  return root.children;
}

function renderList(items, env) {
  const groups = [];
  for (const item of items) {
    if (groups.at(-1)?.[0].ordered === item.ordered) groups.at(-1).push(item);
    else groups.push([item]);
  }
  return groups.map(group => {
    const lis = group.map(item => {
      const changed = env.isChanged(item.from, item.to);
      const text = item.text.map(line => inline(line, env.kindTag)).join('<br>');
      return `<li${cls(changed)}>${mark(text, changed)}${renderList(item.children, env)}</li>`;
    }).join('');
    const [{ ordered, number }] = group;
    return ordered ? `<ol${number !== 1 ? ` start="${number}"` : ''}>${lis}</ol>` : `<ul>${lis}</ul>`;
  }).join('');
}

function list(lines, start, env) {
  const { items, next } = readItems(lines, start);
  return { html: renderList(nest(items), env), next };
}

module.exports = { ITEM, isTable, table, list, mark, cls };
