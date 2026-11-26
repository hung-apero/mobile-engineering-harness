const store = require('./store.cjs');
const { draftsOf } = require('./answer-ledger.cjs');
const { missingOf, leave } = require('./phase-quiz.cjs');
const { enqueue, currentChats, MAX_CHATS } = require('./chats.cjs');
const { createRun, submission, closeWaits } = require('./kit.cjs');
const { OTHER } = require('../web/quiz-model.cjs');
const { isProvisional, provisionalQuiz, submitProvisional, canEdit } = require('./facade-provisional.cjs');
const { provOf } = require('./provisional.cjs');
const { wrongState, invalid } = require('./facade-error.cjs');

const MAX_TEXT = 2000;
const MAX_ASK = 1000;
const SENT = ['quiz', 'clarifying'];

function view(db, spec) {
  const { ask: askIds = [], auto: autoIds = [] } = spec.data.rounds?.at(-1) ?? {};
  const drafts = draftsOf(db, spec);
  const [ask, auto] = [[], []];
  for (const question of spec.data.questions ?? []) {
    const known = spec.data.answered?.[question.id];
    const item = { ...question, draft: drafts.get(question.id) ?? null, answered: Boolean(known), answer: known ? { kind: known.kind, label: known.label, text: known.text } : null };
    if (askIds.includes(question.id)) ask.push(item);
    else if (autoIds.includes(question.id)) auto.push(item);
    else if (known?.kind === 'agent') auto.push({ ...item, mode: 'auto', auto: { label: known.label, source: known.text, reason: '' } });
    else if (known) ask.push({ ...item, draft: null });
  }
  return { ask, auto };
}

const isEditable = (ctx, spec) => (isProvisional(spec) ? canEdit(ctx.db, spec) : spec.state === 'quiz');
const roundOf = spec => (isProvisional(spec) ? provOf(spec).round : spec.round);
const asksOf = (ctx, spec) => (isProvisional(spec) ? provisionalQuiz(ctx, spec).ask : view(ctx.db, spec).ask);

function quiz(ctx, spec) {
  if (isProvisional(spec)) return provisionalQuiz(ctx, spec);
  const submitted = SENT.includes(spec.state) && submission(ctx.db, spec.id, spec.round) !== null;
  const { id, project, title, state, round, updatedAt } = spec;
  return { spec: { id, project, title, state, updatedAt }, round, submitted, ...view(ctx.db, spec), chats: currentChats(ctx.db, spec) };
}

function draftOf(question, { choice, text = '' }) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) throw invalid(`Câu trả lời dài tối đa ${MAX_TEXT} ký tự.`);
  if (choice !== OTHER && !question.options.some(option => option.label === choice)) throw invalid('Lựa chọn này không có trong câu hỏi.');
  return { qid: question.id, choice, text };
}

function save(ctx, spec, questions, input, by, now) {
  if (!isEditable(ctx, spec)) throw wrongState();
  const question = questions.find(item => item.id === input.qid);
  if (!question || question.answer?.kind === 'po') throw invalid('Không có câu hỏi này trong lần hỏi hiện tại.');
  return store.saveDraft(ctx.db, { specId: spec.id, round: roundOf(spec), by, ...draftOf(question, input) }, now);
}

const saveDraft = (ctx, spec, input, by, now) => save(ctx, spec, asksOf(ctx, spec).filter(q => !q.answered), input, by, now);
const changeAuto = (ctx, spec, input, by, now) => save(ctx, spec, isProvisional(spec) ? [] : view(ctx.db, spec).auto, input, by, now);

function submit(ctx, project, spec, by, now) {
  if (isProvisional(spec)) {
    if (!canEdit(ctx.db, spec)) throw wrongState();
    return submitProvisional(ctx, spec, by, now);
  }
  if (spec.state !== 'quiz' || submission(ctx.db, spec.id, spec.round)) throw wrongState();
  const run = createRun(ctx, project, spec, now);
  const missing = missingOf(run);
  if (missing.length) return { ok: false, missing };
  if (!store.submitRound(ctx.db, spec.id, spec.round, by, now)) throw wrongState();
  leave(run);
  closeWaits(ctx.db, spec.id, now, 'quiz');
  return { ok: true, missing: [] };
}

function ask(ctx, spec, qid, text, by, now) {
  if (!isEditable(ctx, spec)) throw wrongState();
  const auto = isProvisional(spec) ? [] : view(ctx.db, spec).auto;
  if (![...asksOf(ctx, spec), ...auto].some(q => q.id === qid)) throw invalid('Không có câu hỏi này trong lần hỏi hiện tại.');
  const question = typeof text === 'string' ? text.trim() : '';
  if (!question || question.length > MAX_ASK) throw invalid(`Câu hỏi thêm cần có nội dung và dài tối đa ${MAX_ASK} ký tự.`);
  if (currentChats(ctx.db, spec, qid).length >= MAX_CHATS) throw invalid(`Mỗi câu chỉ hỏi thêm được ${MAX_CHATS} lần. Hãy chọn câu trả lời hoặc ghi ý của bạn ở ô Khác.`);
  const id = store.addChat(ctx.db, { specId: spec.id, qid, question, by }, now);
  enqueue(ctx.db, spec, { id, specId: spec.id, qid, question }, now);
  return id;
}

module.exports = { quiz, saveDraft, changeAuto, submit, ask };
