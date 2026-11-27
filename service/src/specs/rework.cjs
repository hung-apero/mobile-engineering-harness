const files = require('./repo-files.cjs');
const { patch } = require('./kit.cjs');
const { redact } = require('../redact.cjs');

const MAX_TEXT = 60000;
const FILE = /^inputs\/rework-[1-9]\d{0,5}\.md$/;
const fileOf = n => `inputs/rework-${n}.md`;
const itemsOf = spec => spec.data.rework?.items ?? [];
const reworkOf = spec => itemsOf(spec).map(({ n }) => ({ file: fileOf(n) }));

function addRework(run, { key, reason }) {
  const held = run.spec.data.rework ?? { n: 0, items: [] };
  if (held.items.some(item => item.key === key)) return;
  const n = held.n + 1;
  const text = redact(String(reason ?? '')).slice(0, MAX_TEXT).toWellFormed();
  patch(run, { rework: { n, items: [...held.items, { n, key, text }] } });
}

function clearRework(run) {
  if (itemsOf(run.spec).length) patch(run, { rework: { ...run.spec.data.rework, items: [] } });
}

function textOf({ n, text }) {
  return [`# Yêu cầu làm lại ${n}`, '', 'Tự xác định phần code phải sửa từ nội dung dưới đây; code đã có hay plan đã done không có nghĩa là đã xong.', '', '## Nội dung', '', text, ''].join('\n');
}

function writeRework(run) {
  for (const item of itemsOf(run.spec)) {
    const [name, text] = [fileOf(item.n), textOf(item)];
    if (files.read(run.spec.data.repo, name) !== text) files.write(run.spec.data.repo, name, text);
  }
}

function reworkLine(list = []) {
  if (!Array.isArray(list) || list.some(item => !FILE.test(item?.file ?? ''))) throw new Error('payload.rework không hợp lệ');
  if (!list.length) return [];
  const named = list.map(({ file }) => `.harness-run/${file}`).join('; ');
  return [`- Lượt này làm lại theo yêu cầu của service. Trước mọi việc khác, đọc hết: ${named}. Làm đủ từng ý trong các file đó rồi mới ghi result.json.`];
}

module.exports = { addRework, clearRework, writeRework, reworkOf, reworkLine };
