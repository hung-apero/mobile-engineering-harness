const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);
const tag = (kind, text) => `<span class="tag ${kind}">${esc(text)}</span>`;
const PO_TAG = tag('po', 'PO chọn');
const AGENT_TAG = tag('agent', 'Agent tự chốt');

const clock = ms => (Number.isFinite(ms) ? new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Saigon', dateStyle: 'short', timeStyle: 'short' }) : '');

function page({ title, style, script, body, refresh = '' }) {
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
${refresh ? `<meta http-equiv="refresh" content="0;url=${esc(refresh)}">\n` : ''}<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/base.css">
${style ? `<link rel="stylesheet" href="/static/${style}.css">\n` : ''}${script ? `<script type="module" src="/static/${script}.js"></script>\n` : ''}</head>
<body>
<a class="skip" href="#main">Tới nội dung chính</a>
${body}
${script ? '<noscript><p class="notice warn">Trang này cần bật JavaScript để lưu và gửi.</p></noscript>\n' : ''}</body>
</html>
`;
}

function messagePage(title, text, { refresh = '' } = {}) {
  const link = refresh ? `<p><a class="button" href="${esc(refresh)}">Tiếp tục</a></p>` : '';
  return page({ title, refresh, body: `<main id="main" class="narrow"><h1>${esc(title)}</h1><p class="lead">${esc(text)}</p>${link}</main>` });
}

module.exports = { esc, tag, PO_TAG, AGENT_TAG, clock, page, messagePage };
