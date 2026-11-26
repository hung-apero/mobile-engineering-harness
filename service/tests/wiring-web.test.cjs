const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { createWeb } = require('../src/web/server.cjs');
const { makeHome } = require('./service-fixtures.cjs');
const { send } = require('./web-fixtures.cjs');
const { deps, app: sampleApp } = require('./newapp-fixtures.cjs');

const NOW = Date.parse('2026-11-25T10:00:00+07:00');
const low = (key, summary = `bug ${key}`) => ({ key, summary, status: { name: 'To Do' }, priority: { name: 'Low' }, labels: [] });

async function start(t) {
  const h = makeHome(t);
  h.project('ABC1');
  const ctx = h.context();
  store.ensureVersion(ctx.db, { project: 'ABC1', version: '1.0.0', now: NOW });
  const hits = { low: [low('ABC1-4'), low('ABC1-5', '<script>x</script>')] };
  ctx.bugs.baseContains = async () => ({ ok: true, detail: 'nhánh gốc đã chứa' });
  const searched = [];
  ctx.bugs.jira = async () => ({
    search: async jql => {
      searched.push(jql);
      return jql.includes('priority in (Medium') ? hits.low : [];
    },
  });
  ctx.newappDeps = deps();
  const web = createWeb(ctx, { facade: ctx.facade, port: 0, now: () => NOW });
  const { url } = await web.start();
  t.after(() => web.stop());
  const port = Number(new URL(url).port);
  const get = (target, extra = {}) => send(port, { url: target, ...extra });
  const post = (target, data, extra = {}) => send(port, { method: 'POST', url: target, body: JSON.stringify(data), ...extra, headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...extra.headers } });
  const key = fs.readFileSync(path.join(ctx.secretsDir, 'web-operator-token'), 'utf8').trim();
  const login = async () => ({ cookie: (await get(`/?k=${key}`)).headers['set-cookie'][0].split(';')[0] });
  return { h, ctx, get, post, login, hits, searched };
}

test('release and new-app pages and their calls are closed without the operator cookie', async t => {
  const s = await start(t);
  for (const url of ['/release/ABC1/1.0.0', '/release/ABC1/1.0.0?fresh=1', '/app/new', '/app/new?key=ABC9']) assert.equal((await s.get(url)).status, 403, url);
  for (const url of ['/api/release/ABC1/1.0.0/defer', '/api/app/new', '/api/app/new/check']) assert.equal((await s.post(url, {})).status, 403, url);
  assert.deepEqual(s.searched, []);
});

test('the release page shows the six conditions from the saved result without asking Jira', async t => {
  const s = await start(t);
  kv.set(s.ctx.db, 'bug-release:ABC1:1.0.0', { at: NOW, ready: 'merge', flags: [false, true, true, true, true, null] }, NOW);
  kv.set(s.ctx.db, 'release-defer:ABC1:1.0.0', [{ key: 'ABC1-9', by: 'PO Hà', at: NOW, source: 'cli' }], NOW);
  const res = await s.get('/release/ABC1/1.0.0', { headers: await s.login() });
  assert.equal(res.status, 200);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.match(res.text, new RegExp(`${n}\\. `));
  assert.match(res.text, /Chờ dev merge/);
  assert.match(res.text, /ABC1-9/);
  assert.match(res.text, /hoãn bởi PO Hà/);
  assert.match(res.text, /href="\?fresh=1"/);
  assert.deepEqual(s.searched, []);
});

test('fresh=1 asks Jira and git, lists the open Medium/Low bugs escaped, and a failure falls back to the saved result', async t => {
  const s = await start(t);
  const headers = await s.login();
  const res = await s.get('/release/ABC1/1.0.0?fresh=1', { headers });
  assert.equal(res.status, 200);
  assert.match(res.text, /ABC1-4/);
  assert.match(res.text, /name="key" value="ABC1-4"/);
  assert.doesNotMatch(res.text, /<script>x/);
  assert.match(res.text, /&lt;script&gt;/);
  assert.match(res.text, /nhánh gốc đã chứa/);
  s.ctx.bugs.jira = async () => { throw new Error('Jira sập'); };
  const down = await s.get('/release/ABC1/1.0.0?fresh=1', { headers });
  assert.equal(down.status, 200);
  assert.match(down.text, /Không kiểm được trực tiếp.*Jira sập/);
});

test('an unknown project or version is a 404', async t => {
  const s = await start(t);
  const headers = await s.login();
  assert.equal((await s.get('/release/ABC1/9.9.9', { headers })).status, 404);
  assert.equal((await s.get('/release/ZZZ9/1.0.0', { headers })).status, 404);
  assert.equal((await s.get('/release/abc1/1.0.0', { headers })).status, 404);
});

test('the operator defers listed bugs from the page, by name, recorded with source web; strangers and nameless calls are refused', async t => {
  const s = await start(t);
  const headers = await s.login();
  const ok = await s.post('/api/release/ABC1/1.0.0/defer', { keys: ['ABC1-4'], by: 'PO Hà' }, { headers });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json().deferred, ['ABC1-4']);
  assert.deepEqual(kv.get(s.ctx.db, 'release-defer:ABC1:1.0.0').map(({ key, by, source }) => [key, by, source]), [['ABC1-4', 'PO Hà', 'web']]);
  assert.equal((await s.post('/api/release/ABC1/1.0.0/defer', { keys: ['ABC1-77'], by: 'PO Hà' }, { headers })).status, 400);
  assert.equal((await s.post('/api/release/ABC1/1.0.0/defer', { keys: ['ABC1-5'] }, { headers })).status, 400);
  assert.equal((await s.post('/api/release/ABC1/1.0.0/defer', { keys: 'x', by: 'PO' }, { headers })).status, 400);
  assert.equal((await s.post('/api/release/ABC1/9.9.9/defer', { keys: ['ABC1-5'], by: 'PO' }, { headers })).status, 404);
});

test('the new-app page saves non-secret values, shows the checklist, checks it, and never shows a secret', async t => {
  const s = await start(t);
  const headers = await s.login();
  const empty = await s.get('/app/new', { headers });
  assert.equal(empty.status, 200);
  assert.match(empty.text, /id="app"/);
  const a = sampleApp();
  const body = { key: a.key, name: a.name, package: a.package, applicationId: a.applicationId, repo: a.repo, firebaseProjectId: a.firebaseProjectId, testerGroup: a.testerGroup, jiraProject: a.jiraProject, signing: 'release', ...a.discord, ads: 'temporary', license: 'temporary', api: 'temporary', password: 'hunter2' };
  const saved = await s.post('/api/app/new', body, { headers });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json().key, 'AIP900');
  assert.equal(kv.get(s.ctx.db, 'newapp:AIP900').applicationId, 'com.apero.demolearn');
  assert.equal(JSON.stringify(kv.get(s.ctx.db, 'newapp:AIP900')).includes('hunter2'), false);
  const secretFile = path.join(s.ctx.secretsDir, 'newapp', 'AIP900', 'signing.properties');
  fs.writeFileSync(secretFile, 'storePassword=topsecretvalue\n', { mode: 0o600 });
  const view = await s.get('/app/new?key=AIP900', { headers });
  assert.equal(view.status, 200);
  assert.match(view.text, /repo-empty|Repo GitHub trống/);
  assert.match(view.text, /secrets\/newapp\/AIP900\//);
  assert.match(view.text, /value="com\.apero\.demolearn"/);
  assert.doesNotMatch(view.text, /topsecretvalue|hunter2/);
  const checked = await s.post('/api/app/new/check', { key: 'AIP900' }, { headers });
  assert.equal(checked.status, 200, checked.text);
  assert.equal(checked.json().passed, false);
  assert.ok(checked.json().items.some(item => item.id === 'repo-empty' && item.state === 'ok'));
  assert.doesNotMatch(checked.text, /topsecretvalue/);
  assert.match((await s.get('/app/new?key=AIP900', { headers })).text, /Kiểm lúc/);
  assert.equal((await s.post('/api/app/new/check', { key: 'AIP777' }, { headers })).status, 400);
  assert.equal((await s.post('/api/app/new', { ...body, key: 'bad key' }, { headers })).status, 400);
});

test('home links to the new-app page and to the release page of every followed version', async t => {
  const s = await start(t);
  const res = await s.get('/', { headers: await s.login() });
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/app\/new"/);
  assert.match(res.text, /href="\/release\/ABC1\/1\.0\.0"/);
});
