const files = require('./repo-files.cjs');
const { patch } = require('./kit.cjs');
const { redact } = require('../redact.cjs');

const MAX_TEXT = 60000;
const FILE = /^inputs\/rework-[1-9]\d{0,5}\.md$/;
const PLAN = /^[a-z0-9][a-z0-9-]{0,80}$/;
const fileOf = n => `inputs/rework-${n}.md`;
const itemsOf = spec => spec.data.rework?.items ?? [];
const reworkOf = spec => itemsOf(spec).map(({ n, plans }) => ({ file: fileOf(n), plans }));

function addRework(run, { key, plans, reason }) {
  const held = run.spec.data.rework ?? { n: 0, items: [] };
  if (held.items.some(item => item.key === key)) return;
  const n = held.n + 1;
  const text = redact(String(reason ?? '')).slice(0, MAX_TEXT).toWellFormed();
  patch(run, { rework: { n, items: [...held.items, { n, key, plans, text }] } });
}

function clearRework(run) {
  if (itemsOf(run.spec).length) patch(run, { rework: { ...run.spec.data.rework, items: [] } });
}

function textOf({ n, plans, text }) {
  const scope = plans.length ? `Plan phải code lại: ${plans.join(', ')}` : 'Chưa có plan: planner đọc file này trước khi chia plan.';
  return [`# Yêu cầu làm lại ${n}`, '', scope, '', 'Ở bước planning thì planner phải chia lại plan theo nội dung này.', '', '## Nội dung', '', text, ''].join('\n');
}

function writeRework(run) {
  for (const item of itemsOf(run.spec)) {
    const [name, text] = [fileOf(item.n), textOf(item)];
    if (files.read(run.spec.data.repo, name) !== text) files.write(run.spec.data.repo, name, text);
  }
}

function reworkLine(list = []) {
  if (!Array.isArray(list) || list.some(({ file, plans }) => !FILE.test(file) || !plans.every(id => PLAN.test(id)))) throw new Error('payload.rework không hợp lệ');
  if (!list.length) return [];
  const named = list.map(({ file, plans }) => `.harness-run/${file}${plans.length ? ` (plan ${plans.join(', ')})` : ''}`).join('; ');
  return [`- Lượt này làm lại theo yêu cầu của service. Trước mọi việc khác, đọc hết: ${named}. Làm đủ từng ý trong các file đó theo mục "rework" của skill; code đã có hay tính năng đã done không có nghĩa là đã xong.`];
}

module.exports = { addRework, clearRework, writeRework, reworkOf, reworkLine };
