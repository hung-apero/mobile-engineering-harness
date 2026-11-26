const { verdictMissing, readVerdict, codeHash } = require('./verdicts.cjs');
const { statusOf } = require('./plan-schedule.cjs');
const { codeRoot } = require('./learn-app-state.cjs');
const { planScreensDigestFull } = require('./ui-screens.cjs');

// What one plan still needs before it can be reviewed: its recorded files (tests are written and checked in testing).
function planMissing(root, state, plan) {
  return ((state.plans[plan.id] || {}).files || []).length ? [] : [`plan ${plan.id} chưa ghi file nào đã đổi (learn-app-state.cjs plan --id ${plan.id} --status coded --files …)`];
}

function planLine(root, state, plan, plans) {
  const id = plan.id;
  const status = statusOf(state, id);
  if (status === 'todo') {
    const waiting = plan.depends.filter(dep => statusOf(state, dep) !== 'merged');
    return waiting.length ? `plan ${id} chờ ${waiting.join(', ')} gộp xong` : `plan ${id} chưa bắt đầu (learn-app-state.cjs start-plans)`;
  }
  if (status === 'waiting-po') return `plan ${id} có quyết định chưa chọn — tự chọn theo pick (decide --provisional --why), không hỏi PO`;
  if (status === 'conflict') return `plan ${id} xung đột khi gộp — gọi agent chủ plan giải xung đột trong worktree rồi plan --id ${id} --status coded`;
  if (status === 'reviewed') return `plan ${id} đã chấm xong, chờ gộp (learn-app-state.cjs merge --plan ${id})`;
  if (status === 'coding') {
    const gaps = planScreensDigestFull(root, plan);
    if (gaps.length) return `plan ${id}: chốt digest màn trước khi vẽ — learn-app-state.cjs digest-prefill --plan ${id} (máy điền builtFrom) rồi ui-node-writer chốt door/unclear: ${gaps[0]}`;
  }
  const missing = planMissing(root, state, plan);
  if (missing.length) return `plan ${id}: ${missing[0]}`;
  const review = verdictMissing(root, `review:${id}`, state);
  return review.length ? `plan ${id}: ${review[0].replace(/ \(review:[^)]+\)/, '')} (agent plan-reviewer)` : `plan ${id} chờ ghi đã chấm (plan --id ${id} --status reviewed)`;
}

module.exports = { planMissing, planLine };
