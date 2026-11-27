const { esc, tag } = require('./html.cjs');
const { renderMarkdown } = require('./markdown.cjs');
const { inline } = require('./markdown-inline.cjs');
const { OTHER, list, choiceText } = require('./quiz-model.cjs');
const { MAX_ANSWER, MAX_ASK } = require('./api-quiz.cjs');

const GROUPS = {
  money: 'tiền hoặc việc mua trong app', ads: 'quảng cáo', premium: 'gói trả phí', reward: 'phần thưởng của người dùng',
  'delete-data': 'xoá dữ liệu của người dùng', 'drop-requirement': 'việc bỏ bớt một yêu cầu', 'sample-data': 'dữ liệu mẫu',
  'library-gap': 'phần thư viện có sẵn chưa làm được', conflict: 'chỗ các nguồn nói khác nhau',
};

function reasonOf(question) {
  if (question.reason) return question.reason;
  if (question.forced && Object.hasOwn(GROUPS, question.forced)) return `Câu này liên quan tới ${GROUPS[question.forced]} nên cần chính bạn chọn.`;
  if (question.blocking) return 'Câu trả lời quyết định phần sẽ làm, nên cần bạn chọn trước.';
  return 'Spec và thiết kế chưa đủ căn cứ để tự chốt.';
}

const proposedLabels = question => String(question.proposal?.label ?? '').split('|').filter(Boolean);

function optionRow({ name, value, checked, text, proposed = false, note = '' }) {
  return `<label class="option${proposed ? ' proposed' : ''}"><input type="radio" name="${esc(name)}" value="${esc(value)}"${checked ? ' checked' : ''}><span class="option-text">${text}${proposed ? ` ${tag('propose', 'Đề xuất')}` : ''}${note ? `<span class="note">${inline(note)}</span>` : ''}</span></label>`;
}

function choices(question, draft, prefix = 'pick') {
  const name = `${prefix}-${question.id}`;
  const proposed = proposedLabels(question);
  const options = list(question.options);
  const rows = options.map(option => optionRow({
    name, value: option.label, checked: draft?.choice === option.label, text: inline(option.text),
    proposed: proposed.includes(option.label), note: proposed.includes(option.label) ? question.proposal.reason : '',
  }));
  const other = draft?.choice === OTHER;
  const loose = question.proposal?.reason && !proposed.some(label => options.some(option => option.label === label));
  return `<fieldset><legend class="sr">Chọn câu trả lời cho: ${esc(question.title)}</legend>
${loose ? `<p class="note">${tag('propose', 'Đề xuất')} ${inline(question.proposal.reason)}</p>` : ''}
${rows.join('\n')}
${optionRow({ name, value: OTHER, checked: other, text: options.length ? 'Khác' : 'Câu trả lời của bạn' })}
<div class="field other"><label class="sr" for="${esc(name)}-text">Ý khác của bạn</label><textarea id="${esc(name)}-text" rows="2" maxlength="${MAX_ANSWER}" placeholder="Ghi ý của bạn">${other ? esc(draft.text) : ''}</textarea></div>
</fieldset>`;
}

function chatItem(chat) {
  const answer = chat.state === 'done' ? esc(chat.answer) : chat.state === 'failed' ? 'Chưa trả lời được. Bạn thử hỏi lại nhé.' : 'Đang tìm câu trả lời…';
  return `<li><p class="say you"><span class="sr">Bạn hỏi: </span>${esc(chat.question)}</p><p class="say agent${chat.state === 'open' ? ' waiting' : ''}"><span class="sr">Trả lời: </span>${answer}</p></li>`;
}

function chatBox(question, chats) {
  const mine = chats.filter(chat => chat.qid === question.id);
  const id = `ask-${esc(question.id)}`;
  return `<details class="chat"${mine.length ? ' open' : ''}><summary>Hỏi thêm về câu này</summary>
<p class="help">Hỏi để hiểu rõ hơn. Bạn vẫn cần tự chọn câu trả lời ở trên.</p>
<ol class="log" aria-live="polite">${mine.map(chatItem).join('')}</ol>
<form class="ask"><label class="sr" for="${id}">Câu hỏi thêm</label><textarea id="${id}" rows="1" maxlength="${MAX_ASK}" placeholder="Bạn muốn hỏi gì?"></textarea><button class="button quiet" type="submit">Hỏi</button></form>
<p class="status" role="status"></p></details>`;
}

function card(question, index, total, chats) {
  return `<article class="card" id="q-${esc(question.id)}" data-qid="${esc(question.id)}"${question.blocking ? ' data-blocking' : ''}>
<header><p class="eyebrow">Câu ${index + 1} / ${total} ${question.blocking ? tag('must', 'Cần trả lời') : tag('plain', 'Có thể bỏ qua')}</p><p class="saved" role="status"></p></header>
<h2>${inline(question.title)}</h2>
${question.hideWhy ? '' : `<p class="why"><strong>Vì sao hỏi:</strong> ${inline(reasonOf(question))}</p>`}
${question.body ? `<div class="prose">${renderMarkdown(question.body, { base: 3 })}</div>` : ''}
${choices(question, question.draft)}
${chatBox(question, chats)}
</article>`;
}

function answerLabel(question, value) {
  const label = value?.choice ?? value?.label;
  if (!label) return value?.text ? inline(value.text) : 'Chưa chọn';
  const known = choiceText(question, label);
  return known ? inline(known) : inline(value.text || label);
}

module.exports = { card, choices, answerLabel };
