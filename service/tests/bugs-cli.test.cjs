const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { createContext } = require('../src/context.cjs');
const bugCommands = require('../src/bug-commands.cjs');
const { makeHome } = require('./service-fixtures.cjs');
const { setup, issue, NOW } = require('./bugs-step-fixtures.cjs');

const reopen = h => createContext(h.env);

test('bad arguments print the usage and exit 2', t => {
  const h = makeHome(t);
  const bad = [
    ['bugs'], ['bugs', 'on'], ['bugs', 'on', 'ABC1'], ['bugs', 'on', 'abc1', '1.9.2'], ['bugs', 'on', 'ABC1', 'x y'],
    ['bugs', 'on', 'ABC1', '1.9.2', '--only'], ['bugs', 'on', 'ABC1', '1.9.2', '--only', 'DEF2-1'], ['bugs', 'on', 'ABC1', '1.9.2', '--only', 'ABC1-1,,ABC1-2'],
    ['bugs', 'on', 'ABC1', '1.9.2', '--base', '2026-13-40'], ['bugs', 'on', 'ABC1', '1.9.2', '--base', '25-11-2026'], ['bugs', 'on', 'ABC1', '1.9.2', '--wat', 'x'],
    ['bugs', 'on', 'ABC1', '1.9.2', '--base', '2026-11-20', '--base', '2026-11-21'], ['bugs', 'off', 'ABC1'], ['bugs', 'status', 'abc'], ['bugs', 'status', 'ABC1', 'x'],
    ['bugs', 'poll'], ['bugs', 'poll', 'ABC1', '1.9.2'], ['bugs', 'zap', 'ABC1'], ['batch'], ['batch', 'x'], ['batch', '0'], ['batch', '1', '2'],
  ];
  for (const args of bad) {
    const out = h.dz(...args);
    assert.equal(out.status, 2, args.join(' '));
    assert.match(out.stderr, /Cách dùng/);
  }
});

test('dz bugs on creates the version, turns polling on, stores --only and the --base baseline', t => {
  const h = makeHome(t);
  const out = h.dz('bugs', 'on', 'ABC1', '1.9.2', '--only', 'ABC1-1,ABC1-2', '--base', '2026-11-20');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /chạy khô/);
  const ctx = reopen(h);
  const row = store.getVersion(ctx.db, 'ABC1', '1.9.2');
  assert.equal(row.polling, true);
  assert.equal(row.baselineAt, Date.parse('2026-11-20T00:00:00+07:00'));
  assert.deepEqual(kv.get(ctx.db, 'bug-only:ABC1:1.9.2'), ['ABC1-1', 'ABC1-2']);
  ctx.db.close();
});

test('dz bugs on again without --only clears the filter and keeps the baseline', t => {
  const h = makeHome(t);
  h.dz('bugs', 'on', 'ABC1', '1.9.2', '--only', 'ABC1-1', '--base', '2026-11-20');
  assert.equal(h.dz('bugs', 'on', 'ABC1', '1.9.2').status, 0);
  const ctx = reopen(h);
  assert.equal(kv.get(ctx.db, 'bug-only:ABC1:1.9.2'), null);
  assert.equal(store.getVersion(ctx.db, 'ABC1', '1.9.2').baselineAt, Date.parse('2026-11-20T00:00:00+07:00'));
  ctx.db.close();
});

test('dz bugs on for an unknown project fails with exit 1 and a clear message', t => {
  const h = makeHome(t);
  const out = h.dz('bugs', 'on', 'ZZZ9', '1.9.2');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /không có project ZZZ9/);
});

test('dz bugs off turns polling off; an unknown version is an error', t => {
  const h = makeHome(t);
  assert.equal(h.dz('bugs', 'off', 'ABC1', '1.9.2').status, 1);
  h.dz('bugs', 'on', 'ABC1', '1.9.2');
  assert.equal(h.dz('bugs', 'off', 'ABC1', '1.9.2').status, 0);
  const ctx = reopen(h);
  assert.equal(store.getVersion(ctx.db, 'ABC1', '1.9.2').polling, false);
  ctx.db.close();
});

test('dz bugs status lists versions, open batches and ticket counts', t => {
  const h = makeHome(t);
  h.dz('bugs', 'on', 'ABC1', '1.9.2', '--only', 'ABC1-1');
  const ctx = reopen(h);
  ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, data, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[\"ABC1-1\"]', '{\"phase\":\"fixing\"}', 1, 1)").run();
  ctx.db.close();
  const out = h.dz('bugs', 'status');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /ABC1\n {2}1\.9\.2: polling bật/);
  assert.match(out.stdout, /chỉ nhận: ABC1-1/);
  assert.match(out.stdout, /đợt #1 normal fixing: ABC1-1/);
  assert.match(h.dz('bugs', 'status', 'ABC1').stdout, /1\.9\.2/);
});

test('dz bugs status with nothing turned on says so', t => {
  assert.match(makeHome(t).dz('bugs', 'status').stdout, /Chưa bật/);
});

test('dz batch shows the batch, its tickets and the decisions that name it', t => {
  const h = makeHome(t);
  h.dz('bugs', 'on', 'ABC1', '1.9.2');
  const ctx = reopen(h);
  ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[\"ABC1-1\"]', 1, 1)").run();
  ctx.db.prepare("INSERT INTO decisions (project, code, rule_version, evidence, action, at) VALUES ('ABC1', 'DRY', 'v', '{\"text\":\"jira transition\",\"batchId\":1}', 'would', 5)").run();
  ctx.db.prepare("INSERT INTO decisions (project, code, rule_version, evidence, action, at) VALUES ('ABC1', 'DRY', 'v', '{\"text\":\"khác\",\"batchId\":11}', 'would', 6)").run();
  ctx.db.close();
  const out = h.dz('batch', '1');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Đợt #1 ABC1 1\.9\.2 \(normal\): running/);
  assert.match(out.stdout, /jira transition/);
  assert.doesNotMatch(out.stdout, /khác/);
  assert.equal(h.dz('batch', '99').status, 1);
});

test('dz bugs poll polls every open version once, ignoring the schedule and the polling switch', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue() } });
  store.ensureVersion(s.ctx.db, { project: 'ABC1', version: '1.9.2' });
  const lines = await bugCommands.bugs(s.ctx, ['poll', 'ABC1'], NOW);
  assert.deepEqual(lines, ['ABC1 1.9.2: 1 ticket mới, 0 bị bỏ qua']);
  assert.equal(s.searches().length, 1);
  assert.equal(store.getTicket(s.ctx.db, 'ABC1', 'ABC1-1').state, 'accepted');
  await bugCommands.bugs(s.ctx, ['poll', 'ABC1'], NOW + 1);
  assert.equal(s.searches().length, 2);
});

test('dz bugs poll without a version row is an error', async t => {
  const s = setup(t);
  await assert.rejects(() => bugCommands.bugs(s.ctx, ['poll', 'ABC1'], NOW), /chưa có version nào/);
});
