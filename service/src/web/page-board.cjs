const { redact } = require('../redact.cjs');
const { esc, clock, page, tag } = require('./html.cjs');

const WAITING = new Set(['quiz', 'review', 'waiting-prereq', 'po-trial', 'needs-input', 'parked']);
const BATCHES = { open: 'Đang gom', running: 'Đang chạy' };
const COLUMNS = [['approved', 'Spec duyệt'], ['coded', 'Code xong'], ['trial', 'Bản cài gửi PO'], ['bugs', 'Bug xong'], ['batches', 'Đợt gộp xong']];

const safe = value => esc(redact(String(value ?? '')));
const meta = parts => parts.filter(Boolean).join(' · ');

function row(title, details, badge = '') {
  return `<li class="row"><div><p class="row-title">${title}</p>${details ? `<p class="meta">${details}</p>` : ''}</div>${badge}</li>`;
}

const rows = (items, empty) => (items.length ? `<ul class="rows">${items.join('')}</ul>` : `<p class="empty">${empty}</p>`);

const specRow = spec => row(
  safe(spec.title),
  meta([spec.waitingFor && `chờ ${safe(spec.waitingFor)}`, spec.progress && `${spec.progress.done}/${spec.progress.total} plan`]),
  tag(WAITING.has(spec.state) ? 'wait' : 'plain', spec.label),
);

const bugRow = bug => row(`${safe(bug.key)} ${safe(bug.summary)}`, meta([safe(bug.priority), bug.assignee && safe(bug.assignee)]), bug.loop ? tag('plain', 'bug loop') : '');

function versionBlock(item) {
  const groups = item.groups.map(group => `<h4>${safe(group.status)} <span class="count">${group.bugs.length}</span></h4>${rows(group.bugs.map(bugRow), '')}`).join('');
  return `<h3>Bug bản ${safe(item.version)}</h3><p class="meta">${safe(item.sync)}</p>${groups || '<p class="empty">Chưa có bug nào.</p>'}`;
}

const batchRow = batch => row(`Đợt #${safe(batch.id)} bản ${safe(batch.version)}`, meta([safe(batch.phase), batch.keys.map(safe).join(', ')]), tag('plain', BATCHES[batch.state] ?? batch.state));

function activityTable(days) {
  const head = `<tr><th scope="col">Ngày</th>${COLUMNS.map(([, name]) => `<th scope="col">${name}</th>`).join('')}</tr>`;
  const body = days.map(day => `<tr><th scope="row">${esc(day.day.slice(5).split('-').reverse().join('/'))}</th>${COLUMNS.map(([field]) => `<td>${esc(day[field])}</td>`).join('')}</tr>`);
  return `<table class="activity"><thead>${head}</thead><tbody>${body.join('')}</tbody></table>`;
}

function projectBlock(project) {
  const id = `p-${esc(project.key)}`;
  return `<section class="panel" aria-labelledby="${id}"><h2 id="${id}">${safe(project.key)}</h2>
<h3>Spec</h3>${rows(project.specs.map(specRow), 'Không có spec nào đang làm.')}
${project.bugs.map(versionBlock).join('')}
<h3>Đợt sửa lỗi</h3>${rows(project.batches.map(batchRow), 'Không có đợt nào đang mở.')}
<h3>7 ngày qua</h3>${activityTable(project.activity)}
</section>`;
}

function boardPage(model, now) {
  const slots = typeof model.slots === 'string' ? model.slots : `${model.slots.used}/${model.slots.total}`;
  const body = `<main id="main" class="wide">
<header class="top"><h1>Board</h1></header>
<dl class="facts"><div><dt>Hạn mức</dt><dd>${safe(model.quota)}</dd></div><div><dt>Suất chạy</dt><dd>${safe(slots)}</dd></div></dl>
${model.projects.map(projectBlock).join('\n') || '<p class="empty">Không có dự án nào.</p>'}
<p class="meta">Cập nhật lúc ${clock(now)}. Trang tự tải lại mỗi phút.</p>
</main>`;
  return page({ title: 'Board', style: 'home', body, reload: 60 });
}

module.exports = { boardPage };
