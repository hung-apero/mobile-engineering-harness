const OTHER = 'Khác';
const PENDING = new Set(['open', 'pending', 'queued', 'running']);

const list = value => (Array.isArray(value) ? value : []);
const isOpen = quiz => !quiz.submitted && [undefined, 'quiz'].includes(quiz.spec?.state);
const openQuestions = quiz => list(quiz.ask).filter(question => !question.answered);
const earlierQuestions = quiz => list(quiz.ask).filter(question => question.answered);

function chosen(draft) {
  if (!draft?.choice) return false;
  return draft.choice !== OTHER || Boolean(String(draft.text ?? '').trim());
}

function chatView({ id, qid, question, answer, state }) {
  if (answer) return { id, qid, question, answer, state: 'done' };
  return { id, qid, question, answer: null, state: PENDING.has(state) ? 'open' : 'failed' };
}

const chatsOf = quiz => list(quiz.chats).map(chatView);

function choiceText(question, label) {
  return question.options?.find(option => option.label === label)?.text ?? '';
}

module.exports = { OTHER, list, isOpen, openQuestions, earlierQuestions, chosen, chatsOf, choiceText };
