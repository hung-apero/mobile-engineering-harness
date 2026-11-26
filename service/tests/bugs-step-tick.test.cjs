const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tick } = require('../src/tick.cjs');
const { runService } = require('../src/run.cjs');
const jobs = require('../src/jobs.cjs');
const { fakeWorkers, add, line, OK, sleep } = require('./service-fixtures.cjs');
const { setup, NOW, MIN } = require('./bugs-step-fixtures.cjs');

const batch = ctx => ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();

test('tick returns while a slow bug step is pending, and supervision still runs on the next tick', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = setup(t, { advance: () => gate.then(() => ({ changed: false })) });
  const { ctx } = s;
  const { alive } = fakeWorkers(ctx);
  s.turnOn();
  batch(ctx);
  const id = add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  assert.notEqual(ctx.bugStepPending, null);
  assert.equal(jobs.getJob(ctx.db, id).state, 'running');
  fs.appendFileSync(ctx.deps.logFileFor(jobs.getJob(ctx.db, id)), `${JSON.stringify(OK)}\n`);
  alive.clear();
  await tick(ctx, NOW + 10000);
  assert.equal(jobs.getJob(ctx.db, id).state, 'done');
  assert.equal(s.advances.length, 1);
  release();
  await ctx.bugStepPending;
  assert.equal(ctx.bugStepPending, null);
});

test('a tick with a rejecting bug step resolves and the service log names the failure', async t => {
  const s = setup(t, { advance: () => { throw new Error('hỏng bất ngờ'); } });
  s.turnOn();
  batch(s.ctx);
  await tick(s.ctx, NOW);
  await s.ctx.bugStepPending;
  assert.match(s.h.logs('bug-step-error')[0].error, /hỏng bất ngờ/);
});

test('shutdown waits for a bug step that is about to finish', async t => {
  const s = setup(t);
  const signals = new Map();
  let finished = false;
  const tickFn = async ctx => {
    ctx.bugStepPending = sleep(80).then(() => { finished = true; ctx.bugStepPending = null; });
    setTimeout(() => signals.get('SIGTERM')(), 10);
  };
  assert.equal(await runService(s.ctx, { tickMs: 5, bugWaitMs: 2000, tickFn, on: (name, fn) => signals.set(name, fn) }), 0);
  assert.equal(finished, true);
  assert.equal(fs.existsSync(s.ctx.lockFile), false);
});

test('shutdown gives up on a bug step that never ends after the wait limit and still closes Jira', async t => {
  const s = setup(t);
  let closed = 0;
  s.ctx.bugs.closeAll = async () => { closed++; };
  const signals = new Map();
  const tickFn = async ctx => {
    ctx.bugStepPending = new Promise(() => {});
    setTimeout(() => signals.get('SIGINT')(), 10);
  };
  const began = Date.now();
  assert.equal(await runService(s.ctx, { tickMs: 5, bugWaitMs: 150, tickFn, on: (name, fn) => signals.set(name, fn) }), 0);
  const took = Date.now() - began;
  assert.ok(took >= 140 && took < 3000, `took ${took}`);
  assert.equal(fs.existsSync(s.ctx.lockFile), false);
  assert.equal(closed, 1);
});

test('shutdown closes the Jira adapters after the step has finished', async t => {
  const s = setup(t);
  let closed = 0;
  s.ctx.bugs.closeAll = async () => { closed++; };
  const signals = new Map();
  const tickFn = async () => setTimeout(() => signals.get('SIGTERM')(), 10);
  await runService(s.ctx, { tickMs: 5, tickFn, on: (name, fn) => signals.set(name, fn) });
  assert.equal(closed, 1);
});

test('tick with no version rows starts nothing: the bug step is quiet and cheap', async t => {
  const s = setup(t);
  await tick(s.ctx, NOW);
  await s.ctx.bugStepPending;
  assert.equal(s.fake.connects, 0);
  assert.equal(s.advances.length, 0);
  assert.ok(MIN > 0);
});
