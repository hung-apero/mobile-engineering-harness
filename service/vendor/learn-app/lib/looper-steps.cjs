const STEPS = ['spec', 'scout', 'ask', 'clear', 'update-spec', 'planning', 'coding', 'smoke', 'handoff'];
// The PO approves the clarified spec (g1) and the final code (g3); planning passes on its judge alone.
const GATE_AT = { 'update-spec': 'g1', handoff: 'g3' };
const BACK_EDGES = { smoke: ['coding', 'planning'], handoff: ['coding', 'planning'], coding: ['planning', 'clear'], planning: ['clear'], clear: ['ask'] };
const LOOP_LIMIT = 3;
// Smoke on a real device is capped tighter: after this many smoke→coding rounds the rest is logged as debt.
const SMOKE_LOOP_LIMIT = 2;

const STEP_LABEL = {
  spec: 'nhận spec',
  scout: 'đọc app hiện có',
  ask: 'soạn câu hỏi cho PO',
  clear: 'PO trả lời câu hỏi',
  'update-spec': 'viết lại spec đã làm rõ',
  planning: 'chia việc thành các plan nhỏ',
  coding: 'viết code, chấm và gộp từng plan (nhiều plan cùng lúc)',
  smoke: 'chạy app trên máy: kiểm crash và đi luồng chính',
  handoff: 'ghi context.json, mở PR cho dev test riêng',
};

function stepIndex(step) {
  const index = STEPS.indexOf(step);
  if (index < 0) throw new Error(`Bước không hợp lệ: ${step}`);
  return index;
}

function nextStep(step) {
  return STEPS[stepIndex(step) + 1] || null;
}

function canGoBack(from, to) {
  if (stepIndex(to) >= stepIndex(from)) return false;
  return to === 'spec' || (BACK_EDGES[from] || []).includes(to);
}

function gatesReopenedBy(to) {
  return Object.entries(GATE_AT).filter(([step]) => stepIndex(step) >= stepIndex(to)).map(([, gate]) => gate);
}

function loopKey(from, to) {
  return `${from}>${to}`;
}

module.exports = { STEPS, GATE_AT, BACK_EDGES, LOOP_LIMIT, SMOKE_LOOP_LIMIT, STEP_LABEL, stepIndex, nextStep, canGoBack, gatesReopenedBy, loopKey };
