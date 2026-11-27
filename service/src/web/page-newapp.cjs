const newapp = require('../newapp/index.cjs');
const kv = require('../kv.cjs');
const { redact } = require('../redact.cjs');
const { esc, clock, page, tag } = require('./html.cjs');

const STATES = { ok: ['plain', 'Đạt'], missing: ['wait', 'Thiếu'], wrong: ['wait', 'Sai'], temporary: ['plain', 'Dùng tạm'], unchecked: ['plain', 'Chưa kiểm'] };
const KEY = /^[A-Z][A-Z0-9]+$/;

const safe = value => esc(redact(String(value ?? '')));

function drafts(db) {
  return kv.keys(db, 'newapp:').map(name => name.slice('newapp:'.length)).filter(name => KEY.test(name));
}

function row(item) {
  const [kind, label] = STATES[item.state] ?? ['plain', item.state];
  const need = item.required ? 'bắt buộc' : 'tuỳ chọn';
  return `<li class="row"><div><p class="row-title">${safe(item.text)}</p><p class="meta">${need} · ${safe(item.detail)}</p></div>${tag(kind, label)}</li>`;
}

function field(id, label, value, help = '') {
  return `<div class="field"><label for="${id}">${label}</label><input id="${id}" name="${id}" value="${esc(value ?? '')}" autocomplete="off" maxlength="120"${help ? ` aria-describedby="${id}-h"` : ''}>${help ? `<p class="help" id="${id}-h">${help}</p>` : ''}</div>`;
}

function select(id, label, value) {
  const options = [['', 'Chưa có'], ['provided', 'Đã có'], ['temporary', 'Dùng tạm']].map(([v, text]) => `<option value="${v}"${v === (value ?? '') ? ' selected' : ''}>${text}</option>`).join('');
  return `<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${id}">${options}</select></div>`;
}

function form(app) {
  const d = app?.discord ?? {};
  const o = app?.optional ?? {};
  const signing = `<div class="field"><label for="signing">Chữ ký</label><select id="signing" name="signing"><option value="release"${app?.signing === 'dev-only' ? '' : ' selected'}>Bản release</option><option value="dev-only"${app?.signing === 'dev-only' ? ' selected' : ''}>Chỉ dùng bản dev</option></select></div>`;
  return `<form id="app" class="panel stack" novalidate>
${field('key', 'Mã app', app?.key, 'Viết hoa, ví dụ AIP396')}${field('name', 'Tên hiển thị', app?.name)}${field('package', 'Package', app?.package)}${field('applicationId', 'Application id', app?.applicationId)}
${field('repo', 'Repo GitHub', app?.repo, 'dạng owner/tên')}${field('firebaseProjectId', 'Firebase project id', app?.firebaseProjectId)}${field('testerGroup', 'Nhóm tester Firebase', app?.testerGroup)}${field('jiraProject', 'Project Jira', app?.jiraProject)}
${signing}${field('channelId', 'ID kênh Discord', d.channelId)}${field('po', 'ID Discord của PO', d.po)}${field('qa', 'ID Discord của QA', d.qa)}${field('devOnCall', 'ID Discord của dev trực', d.devOnCall)}
${select('ads', 'Khoá quảng cáo production', o.ads)}${select('license', 'Khoá license', o.license)}${select('api', 'Khoá chat api', o.api)}
<button class="button" type="submit">Lưu giá trị</button>
<p class="status" id="status" role="status"></p>
</form>`;
}

function checklist(view, key, secretsDir) {
  return `<section class="panel" aria-labelledby="list"><h2 id="list">Danh sách của ${safe(key)}</h2>
<p class="meta">${view.checkedAt ? `Kiểm lúc ${clock(view.checkedAt)}` : 'Chưa kiểm lần nào'}. Trang này chỉ nhận giá trị không bí mật. File bí mật chép tay vào ${safe(`${secretsDir}/newapp/${key}/`)} (quyền 600).</p>
<ul class="rows">${view.items.map(row).join('')}</ul>
<p><button class="button" id="check" type="button" data-key="${esc(key)}">Kiểm lại</button></p></section>`;
}

function newAppPage(ctx, key) {
  const wanted = KEY.test(key ?? '') ? key : null;
  let view = null;
  try {
    view = wanted ? newapp.status(ctx, wanted) : null;
  } catch {
    view = null;
  }
  const known = drafts(ctx.db).map(name => `<li><a href="/app/new?key=${esc(name)}">${esc(name)}</a></li>`).join('');
  const body = `<main id="main" class="narrow">
<p class="crumb"><a href="/">← Board</a></p>
<h1>App mới</h1>
<p class="lead">Điền giá trị không bí mật, rồi bấm kiểm. Chỉ khi mọi mục bắt buộc đạt thì dev mới chạy <code>dz newapp create</code>.</p>
${known ? `<p class="meta">Đã có: </p><ul class="inline">${known}</ul>` : ''}
${form(view?.app)}
${view ? checklist(view, wanted, ctx.secretsDir) : ''}
</main>`;
  return page({ title: 'App mới', style: 'home', script: 'app-new', body });
}

module.exports = { newAppPage };
