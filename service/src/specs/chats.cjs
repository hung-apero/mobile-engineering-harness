const store = require('./store.cjs');
const jobs = require('../jobs.cjs');
const { findJob } = require('./kit.cjs');
const { lastResultText } = require('../bugs/result-log.cjs');
const { redact } = require('../redact.cjs');
const { provOf } = require('./provisional.cjs');
const { BUILD_STATES } = require('./build-kit.cjs');

const MAX_CHATS = 20;
const MAX_ANSWER = 4000;
const MAX_HISTORY = 4;
const keyOf = chat => `${chat.specId}#${chat.id}`;
const currentChats = (db, spec, qid) => store.chatsOf(db, spec.id, qid).filter(chat => chat.id > (spec.data.chatFloor ?? 0));

function questionOf(spec, qid) {
  const item = Object.values(provOf(spec).items).find(entry => entry.qid === qid);
  if (!item) return spec.data.questions?.find(q => q.id === qid);
  return { title: item.title, body: '', options: item.options.map(({ label, text }) => ({ label, text })), proposal: item.picked ? { label: item.picked, reason: item.why } : null };
}

function historyOf(db, spec, chat) {
  return currentChats(db, spec, chat.qid)
    .filter(item => item.id < chat.id && item.answer)
    .slice(-MAX_HISTORY)
    .map(({ question, answer }) => ({ question, answer }));
}

function enqueue(db, spec, chat, now) {
  const question = questionOf(spec, chat.qid);
  if (!question || !spec.data.repo) return;
  const { title, body, options, proposal } = question;
  const payload = { specId: spec.id, chatId: chat.id, repo: spec.data.repo, question: { title, body, options, proposal }, history: historyOf(db, spec, chat), text: chat.question };
  jobs.enqueue(db, { project: spec.project, kind: 'explain', key: keyOf(chat), priority: 0, slots: 1, payload }, now);
}

function answerOf(job) {
  try {
    const last = lastResultText(job.logFile);
    const answer = last && !last.isError ? last.structuredOutput?.answer : null;
    return typeof answer === 'string' && answer.trim() ? redact(answer.trim()).slice(0, MAX_ANSWER).toWellFormed() : null;
  } catch {
    return null;
  }
}

function settle(db, spec, chat, now) {
  const job = findJob(db, { project: spec.project, kind: 'explain', key: keyOf(chat) });
  if (!job) {
    if (chat.state === 'open') enqueue(db, spec, chat, now);
    return;
  }
  const answer = job.state === 'done' ? answerOf(job) : null;
  if (answer) store.answerChat(db, chat.id, answer, 'done', now);
  else if (chat.state === 'open' && ['done', 'failed', 'parked'].includes(job.state)) store.answerChat(db, chat.id, null, 'failed', now);
}

function settleChats(ctx, project, now) {
  for (const spec of store.listSpecs(ctx.db, { project: project.key, states: ['quiz', 'clarifying', 'review', ...BUILD_STATES] })) {
    for (const chat of currentChats(ctx.db, spec)) if (!chat.answer) settle(ctx.db, spec, chat, now);
  }
}

module.exports = { enqueue, settleChats, currentChats, MAX_CHATS };
