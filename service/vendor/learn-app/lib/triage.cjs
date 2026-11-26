const { read, questionBlocks, headlessRun, olderThanRawSpec } = require('./looper-parse.cjs');

const FILE = 'triage.json';
const ASK_ONLY = ['money', 'ads', 'premium', 'reward', 'delete-data', 'drop-requirement', 'sample-data', 'library-gap', 'conflict'];
const CATEGORIES = [...ASK_ONLY, 'unclear', 'evidence', 'easy-change'];
const AUTO = ['evidence', 'easy-change'];

const filled = value => typeof value === 'string' && value.trim() !== '';

function itemProblems(question, item) {
  const at = `${FILE} ${question.id}`;
  if (!item) return [`${FILE} thiếu ${question.id}`];
  if (!['ask', 'auto'].includes(item.decision)) return [`${at}: decision phải là ask|auto`];
  const problems = [];
  if (!CATEGORIES.includes(item.category)) problems.push(`${at}: category phải là ${CATEGORIES.join('|')}`);
  if (!filled(item.reason)) problems.push(`${at}: thiếu reason`);
  if (item.decision === 'ask') return problems;
  if (CATEGORIES.includes(item.category) && !AUTO.includes(item.category)) problems.push(`${at}: ${item.category} luôn hỏi PO (S02), không được auto`);
  if (!question.labels.includes(item.label)) problems.push(`${at}: label phải là một trong ${question.labels.join(', ')}`);
  if (!filled(item.source)) problems.push(`${at}: auto cần source (file, mục spec, node Figma hoặc đường dẫn code)`);
  if (question.blocking && item.category === 'easy-change') problems.push(`${at}: câu [chặn] chỉ auto khi category là evidence`);
  return problems;
}

function triageProblems(root, state) {
  const text = read(root, FILE);
  if (text === null) return [`chưa có ${FILE} (spec-clear Mode: ask với Headless: yes)`];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (!parsed || !Array.isArray(parsed.items)) return [`${FILE} sai định dạng: cần { "items": [...] }`];
  if (olderThanRawSpec(root, state, FILE)) return [`${FILE} cũ hơn spec mới — phân loại lại câu hỏi theo spec mới`];
  const byId = Object.fromEntries(parsed.items.filter(Boolean).map(item => [item.id, item]));
  return questionBlocks(read(root, 'questions.md') || '', { agent: headlessRun(root) }).filter(q => !q.answered).flatMap(q => itemProblems(q, byId[q.id]));
}

module.exports = { FILE, ASK_ONLY, CATEGORIES, triageProblems };
