const { esc, page, tag } = require('./html.cjs');
const { inline } = require('./markdown-inline.cjs');
const { list, chosen, chatsOf } = require('./quiz-model.cjs');
const { card, answerLabel } = require('./question-view.cjs');

const NAMES = { po: 'PO', dev: 'Dev', qa: 'QA' };
const HELP = {
  po: 'Hành vi, phạm vi và nội dung sản phẩm.',
  dev: 'Kỹ thuật, SDK, cờ build.',
  qa: 'Cách kiểm tra, dữ liệu và thiết bị test.',
};

function doneList(questions, title, valueOf) {
  if (!questions.length) return '';
  const rows = questions.map(question => `<li class="decided"><h3>${inline(question.title)}</h3><p class="picked">${tag('po', NAMES[question.role] ?? 'PO')} <span>${answerLabel(question, valueOf(question))}</span></p></li>`);
  return `<h3 class="sub">${title}</h3><ul class="decisions">${rows.join('')}</ul>`;
}

function sendBlock(role, questions) {
  const missing = questions.filter(question => !chosen(question.draft)).length;
  return `<div class="send" aria-label="Gửi phần ${NAMES[role]}"><p class="send-help" id="send-help-${role}">${missing ? `Còn ${missing} câu cần trả lời trước khi gửi.` : 'Đã đủ để gửi.'}</p>
<button class="button submit" id="submit-${role}" type="button" aria-describedby="send-help-${role}"${missing ? ' disabled' : ''}>Gửi phần ${NAMES[role]}</button><p class="status send-status" role="alert"></p></div>`;
}

function part(quiz, section, chats) {
  const { role } = section;
  const mine = list(quiz.ask).filter(question => question.role === role);
  const todo = mine.filter(question => !question.answered && !question.sent);
  const sent = mine.filter(question => !question.answered && question.sent);
  const done = mine.filter(question => question.answered);
  const editable = section.open && todo.length > 0;
  return `<section id="${role}" class="panel role-part"${editable ? ` data-part="${role}"` : ''} aria-labelledby="${role}-title">
<h2 id="${role}-title">Phần ${NAMES[role]} <span class="count">${mine.length}</span></h2><p class="help">${HELP[role]} Ai cũng xem được, người phụ trách phần này trả lời và gửi.</p>
${editable ? todo.map((question, i) => card(question, i, todo.length, chats)).join('\n') + sendBlock(role, todo) : ''}
${doneList(sent, 'Đã gửi, đang xử lý', question => question.draft)}
${doneList(done, 'Đã chốt', question => question.answer)}
</section>`;
}

function rolesPage(quiz) {
  const chats = chatsOf(quiz);
  const sections = list(quiz.sections);
  const cards = list(quiz.ask).filter(question => !question.answered && !question.sent && sections.find(section => section.role === question.role)?.open);
  const answered = cards.filter(question => chosen(question.draft)).length;
  const nav = sections.map(section => `<li><a href="#${section.role}"${section.open ? '' : ' class="answered"'}><span class="dot" aria-hidden="true"></span>Phần ${NAMES[section.role]}<span class="nav-title">${section.count} câu${section.open ? '' : ' · đã gửi'}</span></a></li>`).join('');
  const round = quiz.round > 1 ? ` · Lần hỏi ${esc(quiz.round)}` : '';
  const body = `<div class="progress-bar"><label for="progress"><span id="progress-text" role="status">Đã trả lời ${answered} / ${cards.length} câu</span></label><progress id="progress" max="${Math.max(1, cards.length)}" value="${answered}"></progress></div>
<div class="layout"><nav aria-label="Các phần"><ol>${nav}</ol></nav>
<main id="main" data-round="${esc(quiz.round)}"><header class="top"><div><p class="eyebrow">${esc(quiz.spec?.project)}${round}</p><h1>${esc(quiz.spec?.title || 'Câu hỏi về spec')}</h1>
<p class="lead">Các câu phát sinh khi code, chia theo người chốt. Code đang làm theo lựa chọn A; bấm vào phần của bạn để xác nhận hoặc đổi.</p></div></header>
${sections.map(section => part(quiz, section, chats)).join('\n')}
</main></div>`;
  return page({ title: 'Câu hỏi về spec', style: 'quiz', script: 'quiz', body });
}

module.exports = { rolesPage };
