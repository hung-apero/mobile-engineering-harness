const files = require('./repo-files.cjs');
const { redact } = require('../redact.cjs');

const RESULT = /^[-*\s]*Kết quả:\**\s*(pass|fail|blocked)\b/m;
const DEVICE = /^[-*\s]*Máy:\**\s*(.+)$/m;
const SEVERE = /crash|\bANR\b|FATAL|văng|treo|đứng màn|không (?:mở|đi|vào|chạy) được|build đỏ|BUILD FAILED|stuck/i;
const MAX_LINE = 300;

const line = text => redact(String(text ?? '').replace(/[\p{C}\s]+/gu, ' ').trim()).slice(0, MAX_LINE).toWellFormed();

function errorsOf(text) {
  return text.split(/^(?=### )/m).filter(block => /^### /.test(block)).map(block => {
    const title = line(block.split('\n')[0].replace(/^###\s*(?:\d+\.\s*)?/, ''));
    const stack = block.match(/^Stack:\s*([\s\S]*)$/m)?.[1].trim() ?? '';
    const crashed = stack !== '' && !/^không có/i.test(stack);
    return { title, severe: crashed || SEVERE.test(title) };
  });
}

function readSmoke(repo) {
  const text = files.read(repo, 'smoke/report.md');
  if (text === null) return null;
  return { result: text.match(RESULT)?.[1] ?? null, device: line(text.match(DEVICE)?.[1]), errors: errorsOf(text) };
}

function readDebts(repo) {
  const text = files.read(repo, 'debts.md') ?? '';
  return text.split('\n').filter(row => /^[-*]\s+\S/.test(row)).map(row => line(row.replace(/^[-*]\s+/, ''))).slice(0, 20);
}

module.exports = { readSmoke, readDebts };
