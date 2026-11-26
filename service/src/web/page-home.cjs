const { redact } = require('../redact.cjs');
const { esc, clock, page, tag } = require('./html.cjs');
const { list } = require('./quiz-model.cjs');

const JOBS = { queued: 'Đang xếp hàng', starting: 'Đang mở', running: 'Đang chạy', parked: 'Tạm gác', done: 'Xong', failed: 'Lỗi' };
const KINDS = { bug: 'Sửa lỗi', feature: 'Tính năng', spec: 'Làm rõ spec', explain: 'Trả lời câu hỏi thêm', review: 'Kiểm lại', gate: 'Kiểm cổng', build: 'Dựng bản cài', probe: 'Chạy thử', uidiff: 'So giao diện', e2e: 'E2E', normal: 'Thường', highest: 'Gấp' };
const SPECS = { new: 'Mới nhận', reading: 'Đang đọc', asking: 'Đang soạn câu hỏi', quiz: 'Chờ PO trả lời', clarifying: 'Đang viết lại', review: 'Chờ PO duyệt', approved: 'Đã duyệt', 'waiting-prereq': 'Chờ điều kiện trước', building: 'Đang code', provisional: 'Chờ PO chọn', smoking: 'Đang chạy thử', uidiff: 'Đang so giao diện', reviewing: 'Đang kiểm code', candidate: 'Đang dựng bản cài', 'po-trial': 'Chờ PO thử bản cài', landing: 'Đang gộp vào bản', done: 'Xong', 'landed-dry': 'Đã gộp (chạy khô)', 'needs-input': 'Cần bổ sung', parked: 'Tạm gác' };
const BATCHES = { open: 'Đang gom', running: 'Đang chạy', done: 'Xong', abandoned: 'Đã bỏ' };
const ROLES = { po: 'PO', qa: 'QA', dev: 'Dev trực' };
const WAITING = new Set(['quiz', 'review', 'waiting-prereq', 'provisional', 'po-trial', 'needs-input', 'parked', 'failed']);

const safe = value => esc(redact(value ?? ''));
const named = (names, value) => safe(Object.hasOwn(names, value ?? '') ? names[value] : value);
const isLink = value => typeof value === 'string' && /^https?:\/\//i.test(value);
const titled = (text, link) => (isLink(link) ? `<a href="${esc(link)}">${safe(text)}</a>` : safe(text));
const state = (names, value) => tag(WAITING.has(value) ? 'wait' : 'plain', names[value] ?? value ?? '');

function row(title, meta, badge) {
  return `<li class="row"><div><p class="row-title">${title}</p><p class="meta">${meta.filter(Boolean).join(' · ')}</p></div>${badge}</li>`;
}

function section(id, title, rows, empty) {
  const body = rows.length ? `<ul class="rows">${rows.join('')}</ul>` : `<p class="empty">${empty}</p>`;
  return `<section class="panel" aria-labelledby="${id}"><h2 id="${id}">${title}${rows.length ? ` <span class="count">${rows.length}</span>` : ''}</h2>${body}</section>`;
}

const jobRow = job => row(`${named(KINDS, job.kind)} ${safe(job.key)}`, [safe(job.project), job.attempt > 1 ? `lần ${safe(job.attempt)}` : '', safe(job.reason)], state(JOBS, job.state));
const batchRow = batch => row(`<a href="/release/${esc(batch.project)}/${esc(batch.version)}">${safe(batch.project)} ${safe(batch.version)}</a>`, [named(KINDS, batch.kind), list(batch.keys).map(safe).join(', ')], state(BATCHES, batch.state));
const versionRow = item => row(`<a href="/release/${esc(item.project)}/${esc(item.version)}">${safe(item.project)} ${safe(item.version)}</a>`, [safe(item.branch)], '');
const specRow = spec => row(titled(spec.title || `Spec ${spec.id}`, spec.link), [safe(spec.project), clock(spec.updatedAt)], state(SPECS, spec.state));

function waitRow(now) {
  return wait => {
    const hours = Number.isFinite(wait.openedAt) ? Math.floor((now - wait.openedAt) / 3600000) : null;
    const since = hours === null ? '' : hours < 1 ? 'chưa tới 1 giờ' : hours < 48 ? `${hours} giờ` : `${Math.floor(hours / 24)} ngày`;
    return row(titled(wait.subject, wait.link), [safe(wait.project), since && `đã chờ ${since}`], tag('wait', ROLES[wait.role] ?? wait.role ?? ''));
  };
}

function homePage(overview, now) {
  const data = overview ?? {};
  const facts = [['Dịch vụ', data.service], ['Nhận việc', data.intake], ['Hạn mức', data.quota]]
    .map(([name, value]) => `<div><dt>${name}</dt><dd>${value ? safe(value) : 'chưa rõ'}</dd></div>`).join('');
  const body = `<main id="main" class="wide">
<header class="top"><h1>Đang làm gì</h1><nav class="actions"><a class="button" href="/spec/new">Gửi spec mới</a> <a class="button" href="/app/new">App mới</a></nav></header>
<dl class="facts">${facts}</dl>
<div class="grid">
${section('waits', 'Đang chờ ai', list(data.waits).map(waitRow(now)), 'Không chờ ai.')}
${section('specs', 'Spec', list(data.specs).map(specRow), 'Chưa có spec nào.')}
${section('jobs', 'Việc', list(data.jobs).map(jobRow), 'Chưa có việc nào đang mở.')}
${section('batches', 'Đợt sửa lỗi', list(data.batches).map(batchRow), 'Không có đợt sửa lỗi nào đang mở.')}
${section('versions', 'Bản đang theo dõi', list(data.versions).map(versionRow), 'Chưa theo dõi bản nào.')}
${section('projects', 'Dự án', list(data.projects).map(item => row(safe(item.key), [safe(item.note)], '')), 'Chưa có dự án nào.')}
</div>
<p class="meta">Cập nhật lúc ${clock(now)}. Tải lại trang để xem mới nhất.</p>
</main>`;
  return page({ title: 'Trạng thái', style: 'home', body });
}

module.exports = { homePage };
