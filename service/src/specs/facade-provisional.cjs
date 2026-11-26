const store = require('./store.cjs');
const { draftsOf } = require('./answer-ledger.cjs');
const { provOf, openItems } = require('./provisional.cjs');
const { isBuilding } = require('./build-kit.cjs');
const { submission } = require('./kit.cjs');
const { currentChats } = require('./chats.cjs');
const { chosen } = require('../web/quiz-model.cjs');

const isProvisional = spec => isBuilding(spec) && provOf(spec).round !== null;

function questionOf(item) {
  return {
    id: item.qid, title: item.title, body: '', blocking: true, options: item.options.map(({ label, text }) => ({ label, text })),
    proposal: item.picked ? { label: item.picked, reason: item.why || 'Đang tạm làm theo lựa chọn này' } : null,
    reason: item.value === null ? 'Khó quay lại nên phần này đang chờ bạn chọn.' : 'Câu này phát sinh khi code. Đang tạm làm theo đề xuất, cần bạn xác nhận hoặc đổi.',
  };
}

function view(db, spec) {
  const prov = provOf(spec);
  const drafts = draftsOf(db, spec, prov.round);
  const asked = new Set(prov.asked);
  return Object.values(prov.items).filter(item => item.said || asked.has(item.qid)).map(item => ({
    ...questionOf(item), draft: drafts.get(item.qid) ?? null, answered: item.status !== 'open',
    answer: item.status === 'open' ? null : { kind: 'po', label: item.said.label, text: item.said.text },
  }));
}

function provisionalQuiz(ctx, spec) {
  const { id, project, title, state, updatedAt } = spec;
  const { round } = provOf(spec);
  const sent = submission(ctx.db, id, round) !== null;
  const open = !sent && openItems(spec).length > 0;
  return { spec: { id, project, title, state: open ? 'quiz' : state, updatedAt }, round, submitted: sent, provisional: true, ask: view(ctx.db, spec), auto: [], chats: currentChats(ctx.db, spec) };
}

const canEdit = (db, spec) => openItems(spec).length > 0 && submission(db, spec.id, provOf(spec).round) === null;

function submitProvisional(ctx, spec, by, now) {
  const { round } = provOf(spec);
  const drafts = draftsOf(ctx.db, spec, round);
  const missing = openItems(spec).filter(item => !chosen(drafts.get(item.qid))).map(item => item.qid);
  if (missing.length) return { ok: false, missing };
  return { ok: store.submitRound(ctx.db, spec.id, round, by, now), missing: [] };
}

module.exports = { isProvisional, provisionalQuiz, submitProvisional, canEdit, questionOf };
