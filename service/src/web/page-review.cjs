const { esc, page, PO_TAG, AGENT_TAG } = require('./html.cjs');
const { renderMarkdown } = require('./markdown.cjs');
const { inline } = require('./markdown-inline.cjs');
const { changedLines, flatten } = require('./diff-lines.cjs');
const { list } = require('./quiz-model.cjs');
const { isOpen, MAX_QUOTE, MAX_FEEDBACK } = require('./api-review.cjs');
const { trialPage } = require('./page-trial.cjs');

const DEFAULT_QUOTE = 'Tôi duyệt bản này.';

function kindTagFor(review) {
  const tags = new Map();
  for (const choice of list(review.agentChoices)) tags.set(choice.id, AGENT_TAG);
  for (const choice of list(review.poChoices)) tags.set(choice.id, PO_TAG);
  return qid => tags.get(qid) ?? '';
}

function choiceList(items, title, badge) {
  if (!items.length) return '';
  const rows = items.map(item => `<li class="decided"><h3>${inline(item.title || item.id)}</h3><p class="picked">${badge} <span>${inline(item.text || item.label || '')}</span></p>${item.source ? `<p class="source"><strong>Căn cứ:</strong> ${inline(item.source)}</p>` : ''}${item.reason ? `<p class="source"><strong>Lý do:</strong> ${inline(item.reason)}</p>` : ''}</li>`);
  return `<section class="panel"><h2>${title} <span class="count">${items.length}</span></h2><ul class="decisions">${rows.join('')}</ul></section>`;
}

function diffSection(diff) {
  const entries = flatten(diff);
  if (!entries.some(entry => entry.type === 'same')) return '';
  const rows = entries.filter(entry => ['add', 'del'].includes(entry.type) && entry.text.trim());
  if (!rows.length) return '';
  const lines = rows.map(({ type, text }) => `<li class="${type}"><span class="sr">${type === 'add' ? 'Thêm: ' : 'Bỏ: '}</span>${type === 'add' ? `<ins>${esc(text)}</ins>` : `<del>${esc(text)}</del>`}</li>`);
  return `<section class="panel"><details><summary>Xem từng dòng đã thêm và đã bỏ (${rows.length})</summary><ul class="diff">${lines.join('')}</ul></details></section>`;
}

function actions(review) {
  if (review.approved) return '<div class="notice done" role="status"><h2>Đã duyệt</h2><p>Bản này đã được duyệt. Hệ thống sẽ làm theo đúng nội dung dưới đây.</p></div>';
  if (!isOpen(review)) return '<div class="notice" role="status"><p>Bản này đang được sửa theo góp ý. Bạn sẽ được nhắn khi có bản mới để duyệt.</p></div>';
  return `<section class="decide" id="decide" data-sha="${esc(review.sha)}" aria-labelledby="decide-title"><h2 id="decide-title">Bạn thấy bản này thế nào?</h2>
<div class="pair">
<form id="approve" class="panel stack"><h3>Đồng ý toàn bộ</h3><div class="field"><label for="quote">Lời duyệt</label><input id="quote" maxlength="${MAX_QUOTE}" value="${DEFAULT_QUOTE}" autocomplete="off"></div><button class="button" type="submit">Duyệt bản này</button><p class="status" role="alert"></p></form>
<form id="feedback" class="panel stack"><h3>Cần sửa</h3><div class="field"><label for="feedback-text">Góp ý</label><textarea id="feedback-text" rows="4" maxlength="${MAX_FEEDBACK}" placeholder="Ghi chỗ cần đổi và đổi thành gì"></textarea></div><button class="button quiet" type="submit">Gửi góp ý</button><p class="status" role="alert"></p></form>
</div></section>`;
}

function reviewPage(review) {
  if (review.trial) return trialPage(review);
  const changed = changedLines(review.markdown, review.diff);
  const spec = renderMarkdown(review.markdown, { changed, kindTag: kindTagFor(review) });
  const open = isOpen(review);
  const body = `<main id="main" class="wide">
<header class="top"><div><p class="eyebrow">${esc(review.spec?.project)} · ${open ? 'Duyệt spec' : 'Spec'}</p><h1>${esc(review.spec?.title || 'Spec đã viết lại')}</h1><p class="lead">${changed.size ? 'Phần tô màu là phần đã đổi so với bản trước.' : 'Đọc hết rồi duyệt, hoặc góp ý chỗ cần sửa.'}</p></div>${open ? '<a class="button quiet" href="#decide">Tới phần duyệt</a>' : ''}</header>
${open ? '' : actions(review)}
<div class="columns"><article class="panel prose spec" aria-label="Nội dung spec">${spec}</article>
<aside aria-label="Các lựa chọn">${choiceList(list(review.poChoices), 'Bạn đã chọn', PO_TAG)}${choiceList(list(review.agentChoices), 'Đã chốt sẵn', AGENT_TAG)}${diffSection(review.diff)}</aside></div>
${open ? actions(review) : ''}
</main>`;
  return page({ title: 'Duyệt spec', style: 'review', script: open ? 'review' : '', body });
}

module.exports = { reviewPage };
