const { test } = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../src/jobs.cjs');
const commands = require('../src/spec-commands.cjs');
const { ExpectedError } = require('../src/run.cjs');
const { setup } = require('./specs-flow-fixtures.cjs');

const cancel = (s, id = s.id) => commands.spec(s.ctx, ['cancel', String(id)], s.now);
const allJobs = s => s.ctx.db.prepare('SELECT id, state FROM jobs ORDER BY id').all();

test('cancel from quiz closes waits and stops pings', async t => {
  const s = setup(t);
  await s.toQuiz();
  assert.equal(s.waits().length, 1);
  const lines = await cancel(s);
  assert.match(lines[0], /Spec #1 đã huỷ \(từ quiz\)/);
  assert.equal(s.spec().state, 'cancelled');
  assert.deepEqual(s.waits(), []);
  const [decision] = s.decisions('spec-cancelled');
  assert.equal(decision.code, 'OP01');
  for (let i = 0; i < 4; i++) await s.tick(6 * 3600000);
  assert.deepEqual([s.waits(), s.sends], [[], []]);
});

test('cancel parks open job', async t => {
  const s = setup(t);
  await s.until(() => s.running().length === 1);
  const [job] = s.running();
  await cancel(s);
  const after = jobs.getJob(s.ctx.db, job.id);
  assert.equal(after.state, 'parked');
  assert.match(after.parkReason, /huỷ/);
  assert.equal(s.spec().data.cancelledFrom, 'asking');
});

test('cancel twice is idempotent', async t => {
  const s = setup(t);
  await s.toQuiz();
  await cancel(s);
  const again = await cancel(s);
  assert.match(again[0], /Spec #1 đã huỷ \(từ quiz\)/);
  assert.equal(s.decisions('spec-cancelled').length, 1);
});

test('machine ignores cancelled spec', async t => {
  const s = setup(t);
  await s.until(() => s.running().length === 1);
  await cancel(s);
  const before = allJobs(s);
  for (let i = 0; i < 4; i++) await s.tick();
  assert.equal(s.spec().state, 'cancelled');
  assert.deepEqual(allJobs(s), before);
});

test('unknown id is an expected error', async t => {
  const s = setup(t);
  await assert.rejects(cancel(s, 999), error => error instanceof ExpectedError && /không có spec #999/.test(error.message));
});
