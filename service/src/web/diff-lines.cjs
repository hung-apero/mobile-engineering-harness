const { splitLines } = require('./markdown.cjs');

function flatten(diff) {
  const parts = Array.isArray(diff) ? diff : [];
  return parts.flatMap(({ type, text }) => splitLines(String(text ?? '').replace(/\n$/, '')).map(line => ({ type, text: line })));
}

function changedLines(markdown, diff) {
  const entries = flatten(diff);
  if (!entries.some(entry => entry.type === 'same')) return new Set();
  const lines = splitLines(markdown);
  const fresh = entries.filter(entry => entry.type !== 'del');
  while (lines.length > fresh.length && lines.at(-1) === '') lines.pop();
  const aligned = fresh.length >= lines.length && lines.every((line, i) => fresh[i].text === line);
  const added = new Set(entries.filter(entry => entry.type === 'add' && entry.text.trim()).map(entry => entry.text.trim()));
  const isNew = (line, i) => (aligned ? fresh[i].type === 'add' && line.trim() : added.has(line.trim()));
  return new Set(lines.flatMap((line, i) => (isNew(line, i) ? [i] : [])));
}

module.exports = { changedLines, flatten };
