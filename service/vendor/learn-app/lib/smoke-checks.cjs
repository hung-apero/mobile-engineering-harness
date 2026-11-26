const { read, mtime } = require('./looper-parse.cjs');
const { SMOKE_LOOP_LIMIT, loopKey } = require('./looper-steps.cjs');

const REPORT = 'smoke/report.md';

function smokeResult(root) {
  const text = read(root, REPORT);
  if (text === null) return null;
  const result = /^[-*\s]*Kết quả:\**\s*(pass|fail|blocked)\b/m.exec(text);
  const reason = /^[-*\s]*Lý do:\**\s*(.+)$/m.exec(text);
  const plan = /^[-*\s]*plan:\**\s*`?([a-z0-9][a-z0-9-]*)/m.exec(text);
  return { text, result: result && result[1], reason: reason ? reason[1].trim() : 'xem smoke/report.md', plan: plan ? plan[1] : '<plan trong report>' };
}

function lastMergeAt(state) {
  const merges = (state.history || []).filter(h => h.action === 'merge-plan').map(h => Date.parse(h.at)).filter(Number.isFinite);
  return merges.length ? Math.max(...merges) : 0;
}

function smokeDebt(root, state) {
  const smoke = smokeResult(root);
  return Boolean(smoke && smoke.result === 'fail' && ((state.loops || {})[loopKey('smoke', 'coding')] || 0) >= SMOKE_LOOP_LIMIT);
}

function smokeMissing(root, state) {
  const smoke = smokeResult(root);
  if (!smoke) return [`chưa có ${REPORT} (gọi learn-app:smoke-tester)`];
  if (!smoke.result) return [`${REPORT} thiếu dòng "Kết quả: pass|fail|blocked"`];
  if (mtime(root, REPORT) < lastMergeAt(state)) return [`${REPORT} cũ hơn lần gộp plan gần nhất — chạy lại smoke-tester`];
  if (smoke.result === 'blocked') return [`chưa chạy được trên máy: ${smoke.reason} — state wait-po`];
  if (smoke.result === 'fail' && !smokeDebt(root, state)) return [`app còn lỗi trên máy — back --to coding --plan ${smoke.plan} --reason "<lỗi trong ${REPORT}>"`];
  return [];
}

function smokeDebtMissing(root) {
  const smoke = smokeResult(root);
  if (!smoke || smoke.result !== 'fail' || /smoke/.test(read(root, 'debts.md') || '')) return [];
  return [`${REPORT} còn lỗi mà debts.md chưa ghi — chép các lỗi đó vào .learn-app/debts.md (mục smoke, kèm ảnh)`];
}

module.exports = { REPORT, smokeResult, smokeMissing, smokeDebt, smokeDebtMissing };
