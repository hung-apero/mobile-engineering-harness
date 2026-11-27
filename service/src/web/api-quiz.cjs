const { OTHER, list, isOpen, openQuestions, chosen, chatsOf } = require('./quiz-model.cjs');
const { WebError, invalid, closed, stale } = require('./web-error.cjs');

const BY = 'po';
const ROLES = ['po', 'dev', 'qa'];
const MAX_ANSWER = 2000;
const MAX_ASK = 1000;
const MAX_WAITING = 5;

async function openQuiz({ facade, specId, body }, checkRound = true) {
  const quiz = await facade.quiz(specId);
  if (!isOpen(quiz)) throw closed();
  if (checkRound && body.round !== quiz.round) throw stale();
  return quiz;
}

function pick(questions, qid) {
  const question = questions.find(item => item.id === qid);
  if (!question) throw invalid('Không có câu hỏi này trong lần hỏi hiện tại.');
  return question;
}

function readChoice(question, { choice, text = '' }) {
  if (typeof text !== 'string' || text.length > MAX_ANSWER) throw invalid(`Câu trả lời dài tối đa ${MAX_ANSWER} ký tự.`);
  if (choice !== OTHER && !list(question.options).some(option => option.label === choice)) throw invalid('Lựa chọn này không có trong câu hỏi.');
  return { choice, text };
}

async function state({ facade, specId }) {
  const quiz = await facade.quiz(specId);
  const drafts = Object.fromEntries(openQuestions(quiz).filter(item => item.draft).map(item => [item.id, { choice: item.draft.choice, text: item.draft.text ?? '' }]));
  return { round: quiz.round, submitted: Boolean(quiz.submitted), open: isOpen(quiz), drafts, chats: chatsOf(quiz) };
}

async function draft(input) {
  const quiz = await openQuiz(input);
  const question = pick(openQuestions(quiz), input.body.qid);
  const saved = await input.facade.saveDraft(input.specId, { qid: question.id, ...readChoice(question, input.body) }, BY, input.now);
  if (saved === false) throw closed();
  return {};
}

async function submit(input) {
  await openQuiz(input);
  const role = ROLES.includes(input.body.role) ? input.body.role : undefined;
  const result = await input.facade.submit(input.specId, role ?? BY, input.now, role);
  if (!result?.ok) throw new WebError(400, 'MISSING', 'Còn câu cần trả lời trước khi gửi.', { missing: list(result?.missing) });
  return {};
}

async function ask(input) {
  const quiz = await openQuiz(input, false);
  const question = pick([...openQuestions(quiz), ...list(quiz.auto)], input.body.qid);
  const text = typeof input.body.text === 'string' ? input.body.text.trim() : '';
  if (!text || text.length > MAX_ASK) throw invalid(`Câu hỏi thêm cần có nội dung và dài tối đa ${MAX_ASK} ký tự.`);
  if (chatsOf(quiz).filter(chat => chat.state === 'open').length >= MAX_WAITING) {
    throw new WebError(429, 'BUSY', 'Đang có nhiều câu hỏi thêm chờ trả lời. Hãy đợi một chút rồi hỏi tiếp.');
  }
  await input.facade.ask(input.specId, question.id, text, BY, input.now);
  return {};
}

async function auto(input) {
  const quiz = await openQuiz(input);
  const question = pick(list(quiz.auto), input.body.qid);
  const choice = readChoice(question, input.body);
  if (!chosen(choice)) throw invalid('Hãy ghi rõ ý của bạn ở ô Khác.');
  const saved = await input.facade.changeAuto(input.specId, question.id, choice, BY, input.now);
  if (saved === false) throw closed();
  return {};
}

module.exports = { state, draft, submit, ask, auto, MAX_ANSWER, MAX_ASK };
