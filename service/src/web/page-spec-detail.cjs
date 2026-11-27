const { redact } = require('../redact.cjs');
const { esc, page, tag } = require('./html.cjs');
const { timeOf } = require('../board/bug-groups.cjs');
const { specSummary, SEGMENTS } = require('../board/spec-detail.cjs');

const safe = value => esc(redact(String(value ?? '')));
const OWNERS = { po: 'PO', dev: 'dev', sdk: 'SDK' };
const MARK = { done: '✓', current: '●', todo: '○' };
const JOB_STATES = { queued: 'chờ chạy', starting: 'đang mở', running: 'đang chạy', done: 'xong', failed: 'lỗi', parked: 'gác' };
const actionsOf = (job, detail) => (job.state === 'running' ? ['pause', 'stop'] : job.state === 'parked' && detail.heldJobId === job.id ? ['start'] : []);
const ACTION_NAMES = { start: 'Chạy', pause: 'Tạm dừng', stop: 'Dừng' };

const usd = value => `${Math.round(value * 100) / 100} USD`;
const section = (id, title, inner) => `<section class="panel" aria-labelledby="${id}"><h2 id="${id}">${title}</h2>${inner}</section>`;
const list = items => (items.length ? `<ul class="rows">${items.join('')}</ul>` : '');
const item = (title, lines = []) => `<li class="row"><div><p class="row-title">${title}</p>${lines.filter(Boolean).map(line => `<p class="meta">${line}</p>`).join('')}</div></li>`;

function summary(detail) {
  const { nowLine, issueLine } = specSummary(detail);
  const facts = [
    ['Trạng thái', detail.label], ['Phiên bản', detail.version ?? '—'], ['Bản cài', detail.install ? `#${detail.install}` : '—'], ['Chi phí worker', usd(detail.totalUsd)],
  ].map(([name, value]) => `<div><dt>${name}</dt><dd>${safe(value)}</dd></div>`).join('');
  const lines = [nowLine, issueLine, ...detail.products].filter(Boolean).map(line => `<p class="meta">${safe(line)}</p>`).join('');
  return section('summary', 'Tóm tắt', `<dl class="facts">${facts}</dl>${lines || '<p class="empty">Không chờ ai, không có việc đang chạy.</p>'}`);
}

function progress(detail) {
  const rows = detail.steps.map(step => {
    const time = Number.isFinite(step.at) ? timeOf(step.at, detail.now) : '';
    const extra = [time, step.note].filter(Boolean).map(safe).join(' · ');
    return `<li class="step ${step.status}">${MARK[step.status]} ${safe(step.name)}${extra ? ` <span class="meta">${extra}</span>` : ''}</li>`;
  });
  return section('progress', 'Tiến trình', `<ol class="steps">${rows.join('')}</ol>`);
}

const issueRow = issue => item(`${safe(issue.title)} ${tag('plain', OWNERS[issue.owner] ?? safe(issue.owner))}`, [issue.detail && safe(issue.detail)]);

function problems(detail) {
  const { issues, provisional } = detail;
  const groups = [['Chặn merge', issues.blocking], ['Còn mở', issues.open], ['Đã sửa', issues.fixed]]
    .filter(([, items]) => items.length).map(([name, items]) => `<h3>${name} <span class="count">${items.length}</span></h3>${list(items.map(issueRow))}`);
  const fallback = issues.source === 'findings' ? '<p class="meta">Worker chưa ghi danh sách vấn đề cho PO; nguyên văn ghi chú ở phần Kỹ thuật.</p>' : '';
  const temp = provisional.length
    ? `<h3>Tạm theo đề xuất, PO chưa chốt <span class="count">${provisional.length}</span></h3>${list(provisional.map(q => item(`${safe(q.id)} → ${safe(q.label)}`, [safe(q.text)])))}`
    : '';
  const body = groups.join('') + fallback + temp;
  return section('issues', 'Vấn đề', body || '<p class="empty">Chưa có vấn đề nào.</p>');
}

const scoreCell = value => `<td>${value === 'ok' ? 'Đạt' : value === null ? '—' : safe(value)}</td>`;

function interface_(detail) {
  const { rounds, screens } = detail.ui;
  if (!screens.length) return section('ui', 'Giao diện', '<p class="empty">Chưa so giao diện.</p>');
  const head = `<tr><th scope="col">Màn</th>${rounds.map(r => `<th scope="col">Vòng ${safe(r)}</th>`).join('')}<th scope="col">Nhận xét gần nhất</th></tr>`;
  const body = screens.map(s => `<tr><th scope="row">${safe(s.name)}</th>${s.scores.map(scoreCell).join('')}<td>${safe(s.last)}</td></tr>`).join('');
  return section('ui', 'Giao diện', `<table class="activity"><thead>${head}</thead><tbody>${body}</tbody></table>`);
}

function buttons(job, operator, detail) {
  if (!operator) return '';
  return actionsOf(job, detail).map(action => `<button type="button" data-job-action="${action}" data-job-id="${esc(job.id)}">${ACTION_NAMES[action]}</button>`).join(' ');
}

function jobRows(detail, operator) {
  return detail.jobs.map(job => `<tr><td>#${esc(job.id)}</td><td>${safe(SEGMENTS[job.segment] ?? job.segment ?? job.kind)}</td><td>${safe(JOB_STATES[job.state] ?? job.state)}</td>`
    + `<td>${Number.isFinite(job.startedAt) ? safe(timeOf(job.startedAt, detail.now)) : '—'}</td><td>${job.costUsd === null ? '—' : safe(usd(job.costUsd))}</td>`
    + `<td>${job.turns ?? '—'}</td><td>${buttons(job, operator, detail)}</td></tr>`).join('');
}

function technical(detail, operator) {
  const plans = detail.plans.length
    ? `<table class="activity"><tbody>${detail.plans.map(p => `<tr><td>${safe(p.id)}</td><td>${safe(p.title)}</td><td>${safe(p.status)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">Chưa có plan.</p>';
  const jobs = detail.jobs.length
    ? `<table class="activity"><thead><tr><th>Job</th><th>Việc</th><th>Trạng thái</th><th>Bắt đầu</th><th>Chi phí</th><th>Lượt</th><th></th></tr></thead><tbody>${jobRows(detail, operator)}</tbody></table>`
    : '<p class="empty">Chưa có job.</p>';
  const raw = detail.issues.raw.length ? `<h3>Ghi chú review nguyên văn</h3>${list(detail.issues.raw.map(text => item(safe(text))))}` : '';
  const git = [detail.branch && `Nhánh ${safe(detail.branch)}`, detail.commit && `commit ${safe(detail.commit)}`].filter(Boolean).join(' · ');
  return `<section class="panel"><details><summary><h2>Kỹ thuật</h2></summary>${git ? `<p class="meta">${git}</p>` : ''}<h3>Plan</h3>${plans}<h3>Job · tổng ${safe(usd(detail.totalUsd))}</h3>${jobs}${raw}</details></section>`;
}

function logPanel(detail, token, key, operator) {
  const job = detail.jobs.find(item => ['starting', 'running'].includes(item.state)) ?? detail.jobs[0];
  if (!job) return '';
  const url = `/board/${esc(token)}/${esc(key)}/job/${esc(job.id)}/log`;
  const name = safe(SEGMENTS[job.segment] ?? job.segment ?? job.kind);
  return section('log', `Log job #${esc(job.id)} · ${name}`, `<div class="log" data-log="${url}" role="log" aria-live="polite"><p class="empty">Đang tải log…</p></div><p class="meta job-status" role="status"></p>${operator ? `<p class="actions">${buttons(job, operator, detail)}</p>` : ''}`);
}

function specDetailPage(detail, { token, key, operator, now }) {
  const back = `/board/${esc(token)}/${esc(key)}`;
  const body = `<main id="main" class="wide">
<p class="meta"><a href="${back}">← ${esc(key)}</a></p>
<header class="top"><h1>${safe(detail.title)}</h1>${tag('plain', detail.label)}</header>
${summary(detail)}
${progress(detail)}
${logPanel(detail, token, key, operator)}
${problems(detail)}
${interface_(detail)}
${technical(detail, operator)}
<p class="meta">Cập nhật lúc ${esc(timeOf(now, now))}. Trang tự tải lại mỗi phút.</p>
</main>`;
  return page({ title: `${detail.title} · ${key}`, style: 'home', script: 'job-log', body, reload: 60 });
}

module.exports = { specDetailPage };
