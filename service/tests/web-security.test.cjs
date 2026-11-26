const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { QUIZ, REVIEW, createFake, startWeb, fail } = require('./web-fixtures.cjs');
const { createWeb } = require('../src/web/server.cjs');

const draft = { qid: 'Q1', choice: 'A', text: '', round: 1 };
const bad = i => `bad${String(i).padStart(40, '0')}`;

test('a request with a foreign Host is refused on every path', async t => {
  const web = await startWeb(t);
  for (const url of ['/', `/quiz/${QUIZ}`, '/static/base.css']) {
    for (const host of ['evil.example', `evil.example:${web.port}`, '127.0.0.1:1', `127.0.0.1.evil.example:${web.port}`]) {
      assert.equal((await web.get(url, { host })).status, 403, `${url} ${host}`);
    }
  }
  assert.equal((await web.get(`/quiz/${QUIZ}`, { host: `localhost:${web.port}` })).status, 200);
});

test('a POST without an exact same Origin is refused and never reaches the facade', async t => {
  const web = await startWeb(t);
  for (const origin of ['http://evil.example', 'null', `https://127.0.0.1:${web.port}`, `http://localhost:${web.port}`, '']) {
    assert.equal((await web.post(`/api/quiz/${QUIZ}/draft`, draft, { headers: { origin } })).status, 403, origin);
  }
  const missing = await web.get(`/api/quiz/${QUIZ}/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
  assert.equal(missing.status, 403);
  const cross = await web.post(`/api/quiz/${QUIZ}/draft`, draft, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  assert.equal(web.facade.calls.length, 0);
});

test('a POST that is not JSON is refused', async t => {
  const web = await startWeb(t);
  const res = await web.post(`/api/quiz/${QUIZ}/draft`, 'qid=Q1', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 415);
  for (const body of ['{', '[]', 'null', '"x"']) assert.equal((await web.post(`/api/quiz/${QUIZ}/draft`, body)).status, 400, body);
});

test('a body over 64 KB is refused, declared or streamed', async t => {
  const web = await startWeb(t);
  const big = JSON.stringify({ ...draft, text: 'x'.repeat(64 * 1024) });
  assert.equal((await web.post(`/api/quiz/${QUIZ}/draft`, big)).status, 413);
  assert.equal((await web.post(`/api/quiz/${QUIZ}/draft`, big, { headers: { 'transfer-encoding': 'chunked' } })).status, 413);
  assert.equal(web.facade.calls.length, 0);
});

test('a wrong method gets 405 with Allow', async t => {
  const web = await startWeb(t);
  const put = await web.get(`/quiz/${QUIZ}`, { method: 'PUT' });
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'GET, HEAD');
  const get = await web.get(`/api/quiz/${QUIZ}/draft`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  assert.equal((await web.get(`/quiz/${QUIZ}`, { method: 'HEAD' })).status, 200);
});

test('every answer carries CSP, no-store and no-referrer', async t => {
  const web = await startWeb(t);
  for (const url of [`/quiz/${QUIZ}`, `/review/${REVIEW}`, '/static/base.css', '/nope', `/quiz/${bad(1)}`]) {
    const { headers } = await web.get(url);
    const csp = headers['content-security-policy'];
    assert.ok(csp.startsWith("default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'"), url);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['x-content-type-options'], 'nosniff');
  }
});

test('pages use no inline script, inline style or outside address', async t => {
  const web = await startWeb(t);
  for (const url of [`/quiz/${QUIZ}`, `/review/${REVIEW}`]) {
    const { text } = await web.get(url);
    assert.doesNotMatch(text, /<style|\sstyle=|\son\w+=/i);
    for (const [tag] of text.matchAll(/<script[^>]*>/g)) assert.match(tag, /src="\/static\//);
    assert.doesNotMatch(text, /(?:src|href)="https?:/);
  }
});

test('a wrong, expired or other-purpose link shows a Vietnamese 404', async t => {
  const web = await startWeb(t);
  for (const url of [`/quiz/${bad(1)}`, `/quiz/${REVIEW}`, `/review/${QUIZ}`, '/quiz/x', `/quiz/${QUIZ}/..`]) {
    const res = await web.get(url);
    assert.equal(res.status, 404, url);
  }
  assert.match((await web.get(`/quiz/${bad(2)}`)).text, /hết hạn/);
  delete web.tokens.quiz[QUIZ];
  assert.equal((await web.post(`/api/quiz/${QUIZ}/draft`, draft)).status, 404);
  assert.equal(web.facade.calls.length, 0);
});

test('guessing tokens is slowed down, a link that already worked still works', async t => {
  const web = await startWeb(t);
  assert.equal((await web.get(`/quiz/${QUIZ}`)).status, 200);
  for (let i = 0; i < 20; i++) assert.equal((await web.get(`/quiz/${bad(i)}`)).status, 404);
  const blocked = await web.get(`/quiz/${bad(99)}`);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await web.get(`/review/${REVIEW}`)).status, 429);
  assert.equal((await web.get(`/quiz/${QUIZ}`)).status, 200);
  web.clock.now += 11 * 60 * 1000;
  assert.equal((await web.get(`/review/${REVIEW}`)).status, 200);
});

test('reloading one expired link does not block the address', async t => {
  const web = await startWeb(t);
  for (let i = 0; i < 30; i++) await web.get(`/quiz/${bad(1)}`);
  assert.equal((await web.get(`/review/${REVIEW}`)).status, 200);
});

test('facade errors map to 404, 409, 400, 409 and 500 without leaking', async t => {
  const codes = { NOT_FOUND: 404, STATE: 409, INVALID: 400, STALE: 409, BOOM: 500 };
  let code;
  const web = await startWeb(t, { facade: createFake({ saveDraft: () => { throw fail(code); } }) });
  for (const [name, status] of Object.entries(codes)) {
    code = name;
    const res = await web.post(`/api/quiz/${QUIZ}/draft`, draft);
    assert.equal(res.status, status, name);
    assert.equal(res.json().ok, false);
    if (name !== 'INVALID') assert.doesNotMatch(res.text, /facade/);
  }
  assert.equal(web.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(web.logs), new RegExp(QUIZ));
});

test('the server binds 127.0.0.1 unless DZ_WEB_HOST is set', async t => {
  const web = await startWeb(t);
  assert.match(web.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const empty = await startWeb(t, { host: '' });
  assert.match(empty.url, /^http:\/\/127\.0\.0\.1:/);
  const other = createWeb({ ...web.ctx, env: { DZ_WEB_HOST: 'localhost', DZ_WEB_PORT: '0' } }, { facade: createFake(), resolveToken: () => null });
  const { url } = await other.start();
  await other.stop();
  assert.match(url, /^http:\/\/localhost:\d+$/);
  for (const DZ_WEB_PORT of ['abc', '-1', '70000']) assert.throws(() => createWeb({ ...web.ctx, env: { DZ_WEB_PORT } }, { facade: createFake() }), /DZ_WEB_PORT/);
});

test('a busy port rejects start', async t => {
  const web = await startWeb(t);
  const other = createWeb(web.ctx, { facade: createFake(), port: web.port, resolveToken: () => null });
  await assert.rejects(other.start(), /EADDRINUSE/);
  await other.stop();
});

test('the operator token stays valid when a second server fails to start', async t => {
  const web = await startWeb(t);
  const before = fs.readFileSync(web.tokenFile, 'utf8');
  const other = createWeb(web.ctx, { facade: createFake(), port: web.port, resolveToken: () => null });
  await assert.rejects(other.start());
  assert.equal(fs.readFileSync(web.tokenFile, 'utf8'), before);
});

test('static files are a fixed list, no path escapes', async t => {
  const web = await startWeb(t);
  assert.match((await web.get('/static/base.css')).headers['content-type'], /text\/css/);
  assert.match((await web.get('/static/quiz.js')).headers['content-type'], /javascript/);
  for (const url of ['/static/../server.cjs', '/static/%2e%2e/server.cjs', '/static/', '/static/constructor', '//evil', '/%']) {
    assert.equal((await web.get(url)).status, 404, url);
  }
});
