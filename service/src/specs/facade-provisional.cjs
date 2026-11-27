const store = require('./store.cjs');
const { draftsOf } = require('./answer-ledger.cjs');
const { provOf, roleOf, rolesOpen, unsentOf, sentIds, ROLES } = require('./provisional.cjs');
const { isBuilding } = require('./build-kit.cjs');
const { currentChats } = require('./chats.cjs');
const { chosen } = require('../web/quiz-model.cjs');

const isProvisional = spec => isBuilding(spec) && provOf(spec).round !== null;
const roleIn = (role, fallback = 'po') => (ROLES.includes(role) ? role : fallback);
const GENERIC = new Set(['Người kiểm code thấy điểm cần PO chốt', 'Lượt code gặp điểm cần PO chốt, agent tạm chọn để làm tiếp', 'Người kiểm code thấy điểm cần chốt', 'Lượt code gặp điểm cần chốt, agent tạm chọn để làm tiếp']);

function questionOf(item) {
  return {
    id: item.qid, role: roleOf(item), title: item.title, body: item.body ?? '', blocking: true,
    options: item.options.map(({ label, text }) => ({ label, text })), current: item.picked,
    proposal: { label: item.recommend ?? item.picked, reason: GENERIC.has(item.why) ? '' : item.why ?? '' }, hideWhy: true,
  };
}

function view(db, spec) {
  const prov = provOf(spec);
  const drafts = draftsOf(db, spec, prov.round);
  const asked = new Set(prov.asked);
  return Object.values(prov.items).filter(item => item.status !== 'merged' && (item.said || asked.has(item.qid))).map(item => {
    const sent = sentIds(prov, roleOf(item)).has(item.qid);
    return {
      ...questionOf(item), draft: drafts.get(item.qid) ?? null, answered: item.status !== 'open', sent,
      answer: item.status === 'open' ? null : { kind: 'po', label: item.said.label, text: item.said.text, by: item.said.by },
    };
  });
}

function sectionsOf(spec, ask) {
  const prov = provOf(spec);
  const open = rolesOpen(spec);
  return ROLES.map(role => ({
    role, open: open.includes(role), count: ask.filter(question => question.role === role).length, sent: prov.sent?.[role] ? { by: prov.sent[role].by, at: prov.sent[role].at } : null,
  })).filter(section => section.count > 0);
}

function provisionalQuiz(ctx, spec) {
  const { id, project, title, state, updatedAt } = spec;
  const { round } = provOf(spec);
  const open = rolesOpen(spec).length > 0;
  const ask = view(ctx.db, spec);
  return {
    spec: { id, project, title, state: open ? 'quiz' : state, updatedAt }, round, submitted: !open && ask.length > 0 && ask.every(question => question.answered || question.sent), provisional: true,
    ask, sections: sectionsOf(spec, ask), auto: [], chats: currentChats(ctx.db, spec),
  };
}

const canEdit = (db, spec, role) => (role ? rolesOpen(spec).includes(role) : rolesOpen(spec).length > 0);

function submitProvisional(ctx, spec, role, by, now) {
  const prov = provOf(spec);
  const items = unsentOf(spec, role);
  const drafts = draftsOf(ctx.db, spec, prov.round);
  const missing = items.filter(item => !chosen(drafts.get(item.qid))).map(item => item.qid);
  if (missing.length) return { ok: false, missing };
  const ids = [...sentIds(prov, role), ...items.map(item => item.qid)];
  const saved = store.patchData(ctx.db, spec.id, { prov: { ...prov, sent: { ...prov.sent, [role]: { by, at: now, ids } } } }, now);
  return { ok: Boolean(saved), missing: [] };
}

module.exports = { isProvisional, provisionalQuiz, submitProvisional, canEdit, questionOf, roleIn };
