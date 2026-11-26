const { esc, page } = require('./html.cjs');
const { inline } = require('./markdown-inline.cjs');
const { list } = require('./quiz-model.cjs');
const { MAX_QUOTE, MAX_FEEDBACK } = require('./api-review.cjs');

const DEFAULT_QUOTE = 'Tôi đã thử và duyệt bản cài này.';
const isLink = value => typeof value === 'string' && /^https:\/\//i.test(value);

function facts({ sha, trial }) {
  const rows = [
    ['Commit', `<code>${esc(String(sha).slice(0, 12))}</code>`],
    ['Bản phát hành', esc(trial.version)],
    ...(trial.versionName ? [['Phiên bản trên máy', esc(`${trial.versionName}${trial.versionCode ? ` (${trial.versionCode})` : ''}`)]] : []),
    ...(isLink(trial.pr) ? [['PR nháp', `<a href="${esc(trial.pr)}">${esc(trial.pr)}</a>`]] : []),
    ['Bản cài', trial.live ? 'Đã gửi qua kênh thử bản cài của dự án' : 'Chạy khô: chưa gửi bản cài thật'],
  ];
  return `<dl class="facts">${rows.map(([name, value]) => `<div><dt>${name}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

function notes(trial) {
  const rows = list(trial.notes);
  if (!rows.length) return '<section class="panel"><h2>Điểm cần lưu ý</h2><p>Không còn lệch nào được ghi nhận.</p></section>';
  return `<section class="panel" aria-labelledby="notes-title"><h2 id="notes-title">Điểm cần lưu ý <span class="count">${rows.length}</span></h2><ul class="decisions">${rows.map(text => `<li class="decided">${inline(text)}</li>`).join('')}</ul></section>`;
}

function approveForm(trial) {
  if (trial.open) return `<div class="panel stack"><h3>Chưa duyệt được</h3><p>Còn ${esc(trial.open)} câu tạm chọn cần bạn xác nhận. Hãy trả lời ở link câu hỏi bạn được gửi, rồi tải lại trang này.</p><form id="approve" hidden><input id="quote" value=""><button type="submit" disabled>Duyệt</button><p class="status"></p></form></div>`;
  return `<form id="approve" class="panel stack"><h3>Duyệt bản cài</h3><div class="field"><label for="quote">Lời duyệt</label><input id="quote" maxlength="${MAX_QUOTE}" value="${DEFAULT_QUOTE}" autocomplete="off"></div><button class="button" type="submit">Duyệt bản cài này</button><p class="status" role="alert"></p></form>`;
}

function trialPage(review) {
  const { spec, sha, trial } = review;
  const body = `<main id="main" class="wide">
<header class="top"><div><p class="eyebrow">${esc(spec?.project)} · Thử bản cài</p><h1>${esc(spec?.title || 'Bản cài của tính năng')}</h1><p class="lead">Lời duyệt chỉ tính cho đúng commit này. Có bản mới thì cần thử và duyệt lại.</p></div></header>
${notes(trial)}
${facts(review)}
<section class="decide" id="decide" data-sha="${esc(sha)}" aria-labelledby="decide-title"><h2 id="decide-title">Bạn thử thấy thế nào?</h2>
<div class="pair">
${approveForm(trial)}
<form id="feedback" class="panel stack"><h3>Cần sửa</h3><div class="field"><label for="feedback-text">Góp ý</label><textarea id="feedback-text" rows="4" maxlength="${MAX_FEEDBACK}" placeholder="Ghi màn nào, thấy gì, cần đổi thành gì"></textarea></div><button class="button quiet" type="submit">Gửi góp ý</button><p class="status" role="alert"></p></form>
</div></section>
</main>`;
  return page({ title: 'Thử bản cài', style: 'review', script: 'review', body });
}

module.exports = { trialPage };
