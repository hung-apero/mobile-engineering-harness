const { redact } = require('../redact.cjs');
const { esc, clock, page, tag } = require('./html.cjs');

const WAITING = new Set(['quiz', 'review', 'waiting-prereq', 'po-trial', 'needs-input', 'parked']);
const BATCHES = { open: 'Đang gom', running: 'Đang chạy' };
const COLUMNS = [['approved', 'Spec duyệt'], ['coded', 'Code xong'], ['trial', 'Bản cài gửi PO'], ['bugs', 'Bug xong'], ['batches', 'Đợt gộp xong']];

const safe = value => esc(redact(String(value ?? '')));
const meta = parts => parts.filter(Boolean).join(' · ');
const boardUrl = (token, key) => `/board/${esc(token)}${key ? `/${esc(key)}` : ''}`;
const bugCount = item => item.groups.reduce((sum, group) => sum + group.bugs.length, 0);

function row(title, lines, badge = '') {
  return `<li class="row"><div><p class="row-title">${title}</p>${lines.filter(Boolean).map(line => `<p class="meta">${line}</p>`).join('')}</div>${badge}</li>`;
}

const rows = (items, empty) => (items.length ? `<ul class="rows">${items.join('')}</ul>` : `<p class="empty">${empty}</p>`);
const stateTag = spec => tag(WAITING.has(spec.state) ? 'wait' : 'plain', spec.label);

const specRow = spec => row(safe(spec.title), [spec.waitingFor && `chờ ${safe(spec.waitingFor)}`, ...spec.products.map(safe)], stateTag(spec));

const bugRow = bug => row(`${safe(bug.key)} ${safe(bug.summary)}`, [meta([safe(bug.priority), bug.assignee && safe(bug.assignee)])], bug.loop ? tag('plain', 'bug loop') : '');

function versionBlock(item) {
  const groups = item.groups.map(group => `<h4>${safe(group.status)} <span class="count">${group.bugs.length}</span></h4>${rows(group.bugs.map(bugRow), '')}`).join('');
  return `<h3>Bug bản ${safe(item.version)}</h3><p class="meta">${safe(item.sync)}</p>${groups || '<p class="empty">Chưa có bug nào.</p>'}`;
}

const batchRow = batch => row(`Đợt #${safe(batch.id)} bản ${safe(batch.version)}`, [meta([safe(batch.phase), batch.keys.map(safe).join(', ')])], tag('plain', BATCHES[batch.state] ?? batch.state));

function activityTable(days) {
  const head = `<tr><th scope="col">Ngày</th>${COLUMNS.map(([, name]) => `<th scope="col">${name}</th>`).join('')}</tr>`;
  const body = days.map(day => `<tr><th scope="row">${esc(day.day.slice(5).split('-').reverse().join('/'))}</th>${COLUMNS.map(([field]) => `<td>${esc(day[field])}</td>`).join('')}</tr>`);
  return `<table class="activity"><thead>${head}</thead><tbody>${body.join('')}</tbody></table>`;
}

function facts(model) {
  const slots = typeof model.slots === 'string' ? model.slots : `${model.slots.used}/${model.slots.total}`;
  return `<dl class="facts"><div><dt>Hạn mức</dt><dd>${safe(model.quota)}</dd></div><div><dt>Suất chạy</dt><dd>${safe(slots)}</dd></div></dl>`;
}

function boardShell(title, model, inner, now) {
  const body = `<main id="main" class="wide">
${inner.top}
${facts(model)}
${inner.body}
<p class="meta">Cập nhật lúc ${clock(now)}. Trang tự tải lại mỗi phút.</p>
</main>`;
  return page({ title, style: 'home', body, reload: 60 });
}

function projectRow(token) {
  return project => row(`<a href="${boardUrl(token, project.key)}">${safe(project.key)}</a>`, [
    project.specs.length ? `${project.specs.length} phase đang làm` : 'Không có phase nào đang làm',
    ...project.specs.map(spec => meta([safe(spec.title), safe(spec.label), spec.waitingFor && `chờ ${safe(spec.waitingFor)}`])),
    ...project.bugs.map(item => meta([`${bugCount(item)} bug bản ${safe(item.version)}`, safe(item.sync)])),
    project.batches.length && `${project.batches.length} đợt sửa lỗi đang mở`,
  ], project.specs.some(spec => spec.waitingFor) ? tag('wait', 'Đang chờ người') : '');
}

function boardListPage(model, token, now) {
  return boardShell('Board', model, {
    top: '<header class="top"><h1>Board</h1></header>',
    body: `<section class="panel" aria-labelledby="projects"><h2 id="projects">Dự án</h2>${rows(model.projects.map(projectRow(token)), 'Không có dự án nào.')}</section>`,
  }, now);
}

function boardProjectPage(model, token, now) {
  const { project } = model;
  return boardShell(`Board ${project.key}`, model, {
    top: `<p class="meta"><a href="${boardUrl(token)}">← Mọi dự án</a></p><header class="top"><h1>${safe(project.key)}</h1></header>`,
    body: `<section class="panel" aria-labelledby="phases"><h2 id="phases">Phase đang làm</h2>${rows(project.specs.map(specRow), 'Không có phase nào đang làm.')}</section>
<section class="panel" aria-labelledby="bugs"><h2 id="bugs">Bug</h2>${project.bugs.map(versionBlock).join('') || '<p class="empty">Chưa theo dõi bản nào.</p>'}
<h3>Đợt sửa lỗi</h3>${rows(project.batches.map(batchRow), 'Không có đợt nào đang mở.')}</section>
<section class="panel" aria-labelledby="activity"><h2 id="activity">7 ngày qua</h2>${activityTable(project.activity)}</section>`,
  }, now);
}

module.exports = { boardListPage, boardProjectPage };
