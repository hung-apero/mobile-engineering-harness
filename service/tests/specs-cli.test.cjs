const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runService } = require('../src/run.cjs');
const kv = require('../src/kv.cjs');
const store = require('../src/specs/store.cjs');
const { validSpec } = require('../src/spec-commands.cjs');
const { lineDiff } = require('../src/specs/line-diff.cjs');
const { setup, asked } = require('./specs-flow-fixtures.cjs');
const { makeHome } = require('./service-fixtures.cjs');
const { send } = require('./web-fixtures.cjs');

test('dz spec arguments are checked before anything runs', () => {
  for (const args of [['332470208', '--project', 'ABC1'], ['https://x/pages/9/a', '--project', 'ABC1', '--figma', 'none'], ['list'], ['list', 'ABC1'], ['show', '1'], ['link', '1'], ['refresh', '2'], ['retry', '3'], ['retry', '3', '--figma', 'none']]) assert.equal(validSpec(args), true, args.join(' '));
  for (const args of [[], ['332470208'], ['9', '--project', 'abc'], ['9', '--project', 'ABC1', '--x', '1'], ['--project', 'ABC1'], ['show'], ['show', 'x'], ['retry', '1', '--figma'], ['list', 'x y']]) assert.equal(validSpec(args), false, args.join(' '));
});

test('dz spec creates, lists and shows; bad links and projects exit 1', t => {
  const h = makeHome(t);
  const out = h.dz('spec', '332470208', '--project', 'ABC1');
  assert.match(out.stdout, /Đã nhận spec #1[\s\S]*chạy khô/);
  assert.match(h.dz('spec', 'list').stdout, /#1 ABC1 new/);
  assert.match(h.dz('spec', 'show', '1').stdout, /url 332470208/);
  assert.match(h.dz('status').stdout, /Spec đang làm: new 1/);
  for (const args of [['https://x/y', '--project', 'ABC1'], ['9', '--project', 'ZZZ9'], ['9', '--project', 'ABC1', '--figma', 'https://evil/x']]) assert.equal(h.dz('spec', ...args).status, 1, args.join(' '));
  assert.equal(h.dz('spec', 'link', '1').status, 1);
  assert.equal(h.dz('spec', 'show', '9').status, 1);
  assert.equal(h.dz('web').status, 1);
  assert.equal(h.dz('spec').status, 2);
});

test('dz run serves the quiz through the real facade and stops with the service', async t => {
  const s = setup(t);
  await s.finish(repo => asked(repo));
  const signals = new Map();
  let checked = false;
  const visit = async ctx => {
    const base = kv.get(ctx.db, 'web:url');
    const port = Number(new URL(base).port);
    const token = store.issueToken(ctx.db, { specId: s.id, purpose: 'quiz', ttlMs: 60000 }, Date.now());
    const page = await send(port, { url: `/quiz/${token}` });
    assert.equal(page.status, 200);
    assert.match(page.text, /Change path/);
    const post = (action, data) => send(port, { method: 'POST', url: `/api/quiz/${token}/${action}`, headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.deepEqual((await post('submit', { round: 1 })).json().missing, ['Q1']);
    assert.equal((await post('draft', { round: 1, qid: 'Q1', choice: 'B', text: '' })).status, 200);
    assert.equal((await post('submit', { round: 1 })).status, 200);
    assert.equal((await post('submit', { round: 1 })).status, 409);
    const key = fs.readFileSync(path.join(ctx.secretsDir, 'web-operator-token'), 'utf8').trim();
    assert.match(s.h.dz('web').stdout, new RegExp(`${base}/\\?k=${key}`));
    const login = await send(port, { url: `/?k=${key}` });
    const home = await send(port, { url: '/', headers: { cookie: login.headers['set-cookie'][0].split(';')[0] } });
    assert.match(home.text, /Spec gốc/);
    checked = true;
  };
  const tickFn = ctx => visit(ctx).finally(() => signals.get('SIGTERM')());
  await runService(s.ctx, { tickMs: 5, tickFn, on: (name, fn) => signals.set(name, fn) });
  assert.deepEqual(s.h.logs('tick-error'), []);
  assert.equal(checked, true);
  assert.equal(s.spec().state, 'clarifying');
});

test('a web port that cannot be opened does not stop the service', async t => {
  const s = setup(t);
  s.ctx.env = { ...s.ctx.env, DZ_WEB_PORT: 'x' };
  const signals = new Map();
  const code = await runService(s.ctx, { tickMs: 5, tickFn: async () => signals.get('SIGTERM')(), on: (name, fn) => signals.set(name, fn) });
  assert.equal(code, 0);
  assert.match(s.h.logs('web-error')[0].error, /DZ_WEB_PORT/);
});

test('line diff keeps order and marks only what changed', () => {
  const show = (a, b) => lineDiff(a, b).map(({ type, text }) => `${type[0]}${text}`);
  assert.deepEqual(show('a\nb\nc', 'a\nx\nc\nd'), ['sa', 'db', 'ax', 'sc', 'ad']);
  assert.deepEqual(show('a', 'a'), ['sa']);
  assert.deepEqual(show('', 'a'), ['d', 'aa']);
});
