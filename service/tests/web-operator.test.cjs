const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFake, startWeb, fail } = require('./web-fixtures.cjs');
const { createWeb } = require('../src/web/server.cjs');

const spec = { project: 'AAP864', title: 'Phase 15', source: '332470208', figma: '' };

test('home and new spec are closed without the operator cookie', async t => {
  const web = await startWeb(t);
  for (const url of ['/', '/spec/new', '/?k=wrong', '/?k=', '/?k=constructor']) assert.equal((await web.get(url)).status, 403, url);
  assert.equal((await web.post('/api/spec/new', spec)).status, 403);
  assert.equal((await web.get('/', { headers: { cookie: 'dz_operator=nope' } })).status, 403);
  assert.equal(web.facade.calls.length, 0);
});

test('the operator token is a new 32 byte secret in a 600 file', async t => {
  const web = await startWeb(t);
  const first = fs.readFileSync(web.tokenFile, 'utf8').trim();
  assert.equal(Buffer.from(first, 'base64url').length, 32);
  assert.equal(fs.statSync(web.tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(web.tokenFile)).mode & 0o777, 0o700);
  fs.chmodSync(web.tokenFile, 0o644);
  const again = createWeb(web.ctx, { facade: createFake(), port: 0, resolveToken: () => null });
  await again.start();
  await again.stop();
  assert.notEqual(fs.readFileSync(web.tokenFile, 'utf8').trim(), first);
  assert.equal(fs.statSync(web.tokenFile).mode & 0o777, 0o600);
});

test('the key is traded for an HttpOnly SameSite=Strict cookie that is not the key', async t => {
  const web = await startWeb(t);
  const key = fs.readFileSync(web.tokenFile, 'utf8').trim();
  const res = await web.get(`/?k=${key}`);
  const cookie = res.headers['set-cookie'][0];
  assert.match(cookie, /^dz_operator=[\w-]{43}; /);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag), flag);
  assert.doesNotMatch(cookie + res.text, new RegExp(key));
  assert.match(res.text, /http-equiv="refresh" content="0;url=\/"/);
  const headers = await web.login();
  assert.equal((await web.get('/spec/new', { headers })).status, 200);
  web.clock.now += 31 * 24 * 60 * 60 * 1000;
  assert.equal((await web.get('/spec/new', { headers })).status, 403);
});

test('a new spec turns a link or page number into a url source and text into a pasted one', async t => {
  const web = await startWeb(t);
  const headers = await web.login();
  const cases = [['332470208', { type: 'url', ref: '332470208' }], ['https://x.atlassian.net/wiki/pages/1/a', { type: 'url', ref: 'https://x.atlassian.net/wiki/pages/1/a' }],
    ['# Spec\ndòng hai', { type: 'pasted', text: '# Spec\ndòng hai' }], ['/etc/passwd', { type: 'pasted', text: '/etc/passwd' }]];
  for (const [source, expected] of cases) {
    const res = await web.post('/api/spec/new', { ...spec, source }, { headers });
    assert.equal(res.status, 200);
    assert.equal(res.json().id, 9);
    assert.deepEqual(web.facade.of('newSpec').at(-1).args[0].source, expected);
  }
});

test('a new spec is checked before the facade', async t => {
  const web = await startWeb(t);
  const headers = await web.login();
  const wrong = [{ project: 'NOPE1' }, { project: '' }, { source: '  ' }, { source: { type: 'path', ref: '/etc/passwd' } }, { figma: 'http://evil.example' }, { figma: 'javascript:1' }, { title: 'x'.repeat(201) }];
  for (const part of wrong) assert.equal((await web.post('/api/spec/new', { ...spec, ...part }, { headers })).status, 400, JSON.stringify(part));
  assert.equal(web.facade.calls.length, 0);
  const ok = await web.post('/api/spec/new', { ...spec, figma: 'https://www.figma.com/design/abc/x?node-id=1' }, { headers });
  assert.equal(ok.status, 200);
});

test('the new spec page lists the projects', async t => {
  const web = await startWeb(t);
  const { status, text } = await web.get('/spec/new', { headers: await web.login() });
  assert.equal(status, 200);
  assert.match(text, /<option value="AAP864">/);
  for (const [, id] of text.matchAll(/<label[^>]* for="([^"]+)"/g)) assert.ok(text.includes(`id="${id}"`), id);
});

test('a facade failure on a page shows a plain error page', async t => {
  const web = await startWeb(t, { facade: createFake({ overview: () => { throw fail('BOOM'); } }) });
  const res = await web.get('/spec/new', { headers: await web.login() });
  assert.equal(res.status, 500);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.doesNotMatch(res.text, /facade/);
});
