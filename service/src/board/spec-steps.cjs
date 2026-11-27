const STEPS = ['Đọc', 'Hỏi', 'PO trả lời', 'Làm rõ', 'Duyệt', 'Code', 'Chạy thử', 'So giao diện', 'Kiểm code', 'Bản cài', 'PO thử', 'Gộp'];

const STATE_STEP = {
  new: 0, reading: 0, asking: 1, quiz: 2, clarifying: 3, review: 4, approved: 4, 'waiting-prereq': 4, building: 5, smoking: 6,
  uidiff: 7, reviewing: 8, candidate: 9, 'po-trial': 10, landing: 11, done: 12, 'landed-dry': 12,
};

const ACTION_STEP = {
  'spec-quiz-opened': 1, 'spec-agent-decided': 1, 'spec-approved': 4, 'spec-coded': 5, 'spec-fix': 5, 'spec-smoke-passed': 6,
  'spec-smoke-red': 6, 'spec-ui-round': 7, 'spec-reviewed': 8, 'spec-candidate': 9, 'spec-trial-sent': 10, 'spec-trial-approved': 10,
  'spec-landing': 11, 'spec-landed': 11,
};

const NOTES = { 5: ['spec-fix', n => `sửa lại ${n} lần`], 7: ['spec-ui-round', n => `${n} vòng`] };

function currentStep(state, decisions, from) {
  if (state in STATE_STEP) return STATE_STEP[state];
  if (from in STATE_STEP) return STATE_STEP[from];
  const reached = decisions.map(d => ACTION_STEP[d.action]).filter(Number.isInteger);
  return reached.length ? Math.max(...reached) : 0;
}

function stepsOf(state, decisions, from) {
  const current = currentStep(state, decisions, from);
  return STEPS.map((name, index) => {
    const mine = decisions.filter(d => ACTION_STEP[d.action] === index);
    const step = { name, status: index < current ? 'done' : index === current ? 'current' : 'todo' };
    if (mine.length) step.at = mine.at(-1).at;
    const note = NOTES[index];
    const count = note ? mine.filter(d => d.action === note[0]).length : 0;
    if (count) step.note = note[1](count);
    return step;
  });
}

const MARK = { done: '✓', current: '●', todo: '○' };
const stepLine = steps => steps.map(step => `${MARK[step.status]}${step.name}`).join(' ');

module.exports = { stepsOf, stepLine, STEPS };
