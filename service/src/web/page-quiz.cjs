const { esc, page, PO_TAG, AGENT_TAG } = require('./html.cjs');
const { inline } = require('./markdown-inline.cjs');
const { list, isOpen, openQuestions, earlierQuestions, chosen, chatsOf } = require('./quiz-model.cjs');
const { card, choices, answerLabel } = require('./question-view.cjs');

const STATES = {
  new: 'Hệ thống đang chuẩn bị câu hỏi. Bạn sẽ được nhắn khi xong.',
  reading: 'Hệ thống đang đọc spec và chuẩn bị câu hỏi. Bạn sẽ được nhắn khi xong.',
  asking: 'Hệ thống đang chuẩn bị câu hỏi. Bạn sẽ được nhắn khi xong.',
  'needs-input': 'Spec đang thiếu thông tin nên chưa soạn được câu hỏi.',
  parked: 'Spec này đang tạm dừng.',
  review: 'Spec đã được viết lại và đang chờ duyệt. Hãy mở link duyệt bạn được gửi.',
  approved: 'Spec này đã được duyệt.',
};

function decided(question, open) {
  const draft = chosen(question.draft) ? question.draft : null;
  const byPo = draft ?? (question.answer?.kind === 'po' ? question.answer : null);
  const agent = question.auto ?? question.answer;
  const source = byPo ? null : question.auto?.source || (question.answer?.kind === 'agent' ? question.answer.text : '');
  const locked = question.answer?.kind === 'po';
  return `<li class="decided" id="auto-${esc(question.id)}">
<h3>${inline(question.title)}</h3>
<p class="picked">${byPo ? PO_TAG : AGENT_TAG} <span>${answerLabel(question, byPo ?? { label: agent?.label, text: agent?.text })}</span></p>
${source ? `<p class="source"><strong>Căn cứ:</strong> ${inline(source)}</p>` : ''}
${!byPo && question.auto?.reason ? `<p class="source"><strong>Lý do:</strong> ${inline(question.auto.reason)}</p>` : ''}
${open && !locked ? `<details class="change"><summary>Đổi câu này</summary><form data-auto="${esc(question.id)}">${choices({ ...question, proposal: null }, byPo ?? { choice: agent?.label }, 'auto')}<button class="button quiet" type="submit">Lưu thay đổi</button><p class="status" role="status"></p></form></details>` : ''}
</li>`;
}

function autoSection(quiz, open) {
  const items = list(quiz.auto);
  if (!items.length) return '';
  return `<section id="auto" class="panel" aria-labelledby="auto-title"><h2 id="auto-title">Các câu đã chốt sẵn <span class="count">${items.length}</span></h2>
<p class="help">Những câu này đã có căn cứ rõ nên không cần hỏi bạn. Thấy chưa đúng thì đổi ở đây${open ? '' : ' khi có lần hỏi mới'}.</p>
<ul class="decisions">${items.map(item => decided(item, open)).join('')}</ul></section>`;
}

function answeredSection(questions, title, answerOf) {
  if (!questions.length) return '';
  const rows = questions.map(question => {
    const value = answerOf(question);
    const byAgent = question.answer?.kind === 'agent';
    return `<li class="decided"><h3>${inline(question.title)}</h3><p class="picked">${value ? `${byAgent ? AGENT_TAG : PO_TAG} ` : ''}<span>${value ? answerLabel(question, value) : 'Không trả lời'}</span></p></li>`;
  });
  return `<section class="panel"><h2>${title}</h2><ul class="decisions">${rows.join('')}</ul></section>`;
}

function heading(quiz, lead) {
  const round = quiz.round > 1 ? ` · Lần hỏi ${esc(quiz.round)}` : '';
  return `<header class="top"><div><p class="eyebrow">${esc(quiz.spec?.project)}${round}</p><h1>${esc(quiz.spec?.title || 'Câu hỏi về spec')}</h1><p class="lead">${lead}</p></div></header>`;
}

const SENT = 'Cảm ơn bạn. Hệ thống đang viết lại spec theo các lựa chọn này. Nếu phát sinh câu mới hoặc có bản để duyệt, bạn sẽ được nhắn.';
const SENT_BUILD = 'Cảm ơn bạn. Câu giữ nguyên thì làm tiếp, câu bạn đổi sẽ được code lại. Có bản cài để thử thì bạn sẽ được nhắn.';

function leadOf(quiz) {
  if (quiz.provisional) return 'Các câu phát sinh khi code, đang tạm làm theo đề xuất. Bạn xác nhận hoặc đổi.';
  return quiz.round > 1 ? 'Có thêm câu mới sau khi viết lại spec. Các câu cũ giữ nguyên.' : 'Câu trả lời được lưu ngay khi bạn chọn. Bạn có thể đóng trang và quay lại sau.';
}

function closedPage(quiz) {
  const sent = quiz.submitted;
  const notice = sent
    ? `<div class="notice done" role="status"><h2>Đã gửi câu trả lời</h2><p>${quiz.provisional ? SENT_BUILD : SENT}</p></div>`
    : `<div class="notice" role="status"><p>${esc(STATES[quiz.spec?.state] ?? 'Hệ thống đang xử lý câu trả lời. Bạn sẽ được nhắn khi có việc cần làm.')}</p></div>`;
  const body = `<main id="main" class="narrow">${heading(quiz, sent ? 'Dưới đây là những gì bạn đã chọn.' : 'Hiện chưa có câu nào cần bạn trả lời.')}
${notice}
${answeredSection(openQuestions(quiz), 'Câu trả lời của bạn', question => (chosen(question.draft) ? question.draft : null))}
${answeredSection(earlierQuestions(quiz), 'Đã trả lời trước đó', question => question.answer)}
${sent ? autoSection(quiz, false) : ''}</main>`;
  return page({ title: 'Câu hỏi về spec', style: 'quiz', body });
}

function openPage(quiz) {
  const questions = openQuestions(quiz);
  const chats = chatsOf(quiz);
  const done = questions.filter(question => chosen(question.draft)).length;
  const missing = questions.filter(question => question.blocking && !chosen(question.draft)).length;
  const nav = questions.map((question, i) => `<li><a href="#q-${esc(question.id)}" data-nav="${esc(question.id)}"${chosen(question.draft) ? ' class="answered"' : ''}><span class="dot" aria-hidden="true"></span>Câu ${i + 1}<span class="nav-title">${esc(question.title)}</span></a></li>`).join('');
  const body = `<div class="progress-bar"><label for="progress"><span id="progress-text" role="status">Đã trả lời ${done} / ${questions.length} câu</span></label><progress id="progress" max="${Math.max(1, questions.length)}" value="${done}"></progress></div>
<div class="layout"><nav aria-label="Danh sách câu hỏi"><ol>${nav}</ol></nav>
<main id="main" data-round="${esc(quiz.round)}">${heading(quiz, leadOf(quiz))}
${questions.map((question, i) => card(question, i, questions.length, chats)).join('\n')}
${autoSection(quiz, true)}
${answeredSection(earlierQuestions(quiz), 'Đã trả lời trước đó', question => question.answer)}
<section class="send" aria-label="Gửi câu trả lời"><p id="send-help">${missing ? `Còn ${missing} câu cần trả lời trước khi gửi.` : 'Đã đủ để gửi.'}</p><button class="button" id="submit" type="button" aria-describedby="send-help"${missing ? ' disabled' : ''}>Gửi câu trả lời</button><p class="status" id="send-status" role="alert"></p></section>
</main></div>`;
  return page({ title: 'Câu hỏi về spec', style: 'quiz', script: 'quiz', body });
}

function quizPage(quiz) {
  const empty = !openQuestions(quiz).length && !list(quiz.auto).length;
  return isOpen(quiz) && !empty ? openPage(quiz) : closedPage(quiz);
}

module.exports = { quizPage };
