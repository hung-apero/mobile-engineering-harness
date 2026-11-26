const { splitBlocks, PO_LINE, AGENT_LINE } = require('./questions.cjs');

const MAX = 2000;
const OPTION_OR_PROPOSAL = /^(?:- [A-Z]\.\s|- \*\*Đề xuất)/;

function oneLine(value, max = MAX) {
  return String(value ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/"/g, '”')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function label(value) {
  return oneLine(value, 80).replace(/[*`#]/g, '');
}

function answerLine({ kind, label: l, text, date }) {
  const day = oneLine(date, 10);
  if (kind === 'po') return `- **PO trả lời (${day}): ${label(l)}** — nguyên văn: "${oneLine(text)}"`;
  return `- **Agent tự chốt (${day}): ${label(l)}** — nguồn: "${oneLine(text)}"`;
}

function apply(block, answer) {
  const lines = block.split('\n');
  const hasAgent = lines.some(line => AGENT_LINE.test(line));
  const hasPo = lines.some(line => PO_LINE.test(line));
  if (hasPo) return block;
  if (hasAgent && !(answer.replace && answer.kind === 'po')) return block;
  const kept = lines.filter(line => !AGENT_LINE.test(line));
  let end = kept.length;
  while (end > 1 && kept[end - 1].trim() === '') end--;
  const anchor = kept.reduce((last, line, i) => (OPTION_OR_PROPOSAL.test(line) ? i + 1 : last), 0);
  if (anchor) end = anchor;
  kept.splice(end, 0, answerLine(answer));
  return kept.join('\n');
}

function writeAnswers(md, answers) {
  const byId = new Map();
  for (const answer of answers) if (!byId.has(answer.id)) byId.set(answer.id, answer);
  const text = String(md ?? '');
  const parts = text.split(/^(?=## )/m);
  return parts.map(part => {
    const id = (part.match(/^## (Q\d+)\b/) || [])[1];
    const answer = id && byId.get(id);
    return answer && splitBlocks(part).length ? apply(part, answer) : part;
  }).join('');
}

module.exports = { writeAnswers, oneLine };
