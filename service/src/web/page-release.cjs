const { redact } = require('../redact.cjs');
const { esc, clock, page, tag } = require('./html.cjs');
const { list } = require('./quiz-model.cjs');

const CONDITIONS = [
  'Nhánh gốc đã chứa nhánh của bản',
  'Không còn bug Highest/High mở',
  'Không còn bug Resolved hoặc Reopened',
  'Không còn bug Medium/Low mở (bug đã hoãn không tính)',
  'Không còn câu hỏi PO chờ trả lời',
  'E2E đạt trên cây của bản',
];
const READY = { release: 'Đủ điều kiện release', merge: 'Chờ dev merge', none: 'Chưa đủ điều kiện' };
const MARKS = new Map([[true, tag('plain', 'Đạt')], [false, tag('wait', 'Chưa')], [null, tag('plain', 'Chưa có')]]);

const safe = value => esc(redact(String(value ?? '')));

function row(title, meta, badge) {
  return `<li class="row"><div><p class="row-title">${title}</p><p class="meta">${meta.filter(Boolean).join(' · ')}</p></div>${badge}</li>`;
}

function conditions(found) {
  return found.conditions.map(c => row(`${c.n}. ${safe(CONDITIONS[c.n - 1] ?? '')}`, [safe(c.detail)], MARKS.get(c.ok) ?? MARKS.get(null))).join('');
}

function deferred(found) {
  return found.deferred.map(entry => row(safe(entry.key), [`hoãn bởi ${safe(entry.by)}`, clock(entry.at)], tag('plain', 'Đã hoãn'))).join('');
}

function openRow(item) {
  const box = `<input type="checkbox" name="key" value="${esc(item.key)}"${item.deferred ? ' checked disabled' : ''} aria-label="Hoãn ${esc(item.key)}">`;
  const meta = [safe(item.priority), safe(item.status), item.deferred ? `hoãn bởi ${safe(item.by)}` : ''];
  return `<li class="row"><label class="row-pick">${box} <span class="row-title">${safe(item.key)} ${safe(item.summary)}</span></label><p class="meta">${meta.filter(Boolean).join(' · ')}</p></li>`;
}

function deferSection(view, found) {
  if (view.open === null) {
    const rows = deferred(found);
    const body = rows ? `<ul class="rows">${rows}</ul>` : '<p class="empty">Chưa hoãn bug nào.</p>';
    return `${body}<p><a class="button" href="?fresh=1">Kiểm lại với Jira để chọn bug hoãn</a></p>`;
  }
  const items = list(view.open);
  if (items.length === 0) return '<p class="empty">Không có bug Medium/Low nào đang mở.</p>';
  return `<form id="defer" class="stack" data-project="${esc(found.project)}" data-version="${esc(found.version)}" novalidate>
<ul class="rows">${items.map(openRow).join('')}</ul>
<div class="field"><label for="by">Tên người hoãn</label><input id="by" name="by" maxlength="60" autocomplete="off" required></div>
<button class="button" type="submit">Hoãn các bug đã chọn</button>
<p class="status" id="status" role="status"></p>
</form>`;
}

function releasePage(view, now) {
  const found = view.status;
  const e2e = found.e2e;
  const facts = [
    found.closed ? `Đã đóng bản lúc ${clock(found.closedAt)}, ${found.buildsAfterClose} bản build sau khi đóng` : 'Chưa đóng bản',
    `E2E: ${e2e.running ? 'đang chạy' : e2e.result ? safe(e2e.result.status) : 'chưa có'}, ${safe(e2e.failedRounds)} vòng lỗi`,
    found.checkedAt ? `Kiểm lúc ${clock(found.checkedAt)}` : 'Chưa kiểm lần nào',
  ];
  const problem = view.problem ? `<p class="notice warn">Không kiểm được trực tiếp, đang hiện kết quả đã lưu: ${safe(view.problem)}</p>` : '';
  const body = `<main id="main" class="wide">
<p class="crumb"><a href="/">← Board</a></p>
<header class="top"><h1>${safe(found.project)} ${safe(found.version)}</h1><a class="button" href="?fresh=1">Kiểm lại ngay</a></header>
<p class="lead">${found.state === 'closed' ? 'Bản đã kết thúc' : safe(READY[found.ready] ?? READY.none)}. Nhánh ${safe(found.branch)}.</p>
${problem}
<section class="panel" aria-labelledby="conds"><h2 id="conds">6 điều kiện</h2><ul class="rows">${conditions(found)}</ul>${view.fresh ? '' : '<p class="meta">Đang hiện kết quả đã lưu, bấm “Kiểm lại ngay” để hỏi Jira và git.</p>'}</section>
<section class="panel" aria-labelledby="facts"><h2 id="facts">Tình trạng</h2><ul class="rows">${facts.map(text => `<li class="row"><p>${text}</p></li>`).join('')}</ul></section>
<section class="panel" aria-labelledby="defer-h"><h2 id="defer-h">Bug Medium/Low</h2>${deferSection(view, found)}</section>
<p class="meta">Mở lúc ${clock(now)}.</p>
</main>`;
  return page({ title: `${found.project} ${found.version}`, style: 'home', script: view.open === null || list(view.open).length === 0 ? '' : 'release', body });
}

module.exports = { releasePage };
