const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const health = require('../src/health.cjs');
const { processStart } = require('../src/worker.cjs');
const { makeHome, add, fakeWorkers, waitFor, line, OK, NOW, MIN } = require('./service-fixtures.cjs');

const states = (ctx, ...ids) => ids.map(id => jobs.getJob(ctx.db, id).state);
const decisions = (ctx, code) => ctx.db.prepare('SELECT * FROM decisions WHERE code = ? ORDER BY id').all(code);
const rejected = resetsAt => ({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } });

function writeLog(ctx, id, ...events) {
  fs.appendFileSync(ctx.deps.logFileFor(jobs.getJob(ctx.db, id)), events.map(e => `${JSON.stringify(e)}\n`).join(''));
}

test('a tick fills free slots and stops when none is left', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const ids = ['a', 'b', 'c', 'd'].map(key => add(ctx, 'ABC1', key));
  await tick(ctx, NOW);
  assert.deepEqual(states(ctx, ...ids), ['running', 'running', 'queued', 'queued']);
  for (const id of ids.slice(0, 2)) {
    const job = jobs.getJob(ctx.db, id);
    assert.equal(processStart(job.pid), job.pidStart);
    assert.equal(job.logFile, ctx.deps.logFileFor(job));
  }
  await tick(ctx, NOW + 10000);
  assert.deepEqual(states(ctx, ...ids), ['running', 'running', 'queued', 'queued']);
});

test('a finished worker is recorded as done and its slot is reused', async t => {
  const h = makeHome(t, ['ABC1'], [line(OK)]);
  const ctx = h.context();
  const ids = ['a', 'b', 'c'].map(key => add(ctx, 'ABC1', key));
  await tick(ctx, NOW);
  const first = jobs.getJob(ctx.db, ids[0]);
  await waitFor(() => processStart(first.pid) !== first.pidStart);
  await tick(ctx, NOW + 10000);
  assert.equal(states(ctx, ids[0])[0], 'done');
  assert.notEqual(states(ctx, ids[2])[0], 'queued');
});

test('intake closed: running jobs are still supervised, nothing new starts', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls, alive } = fakeWorkers(ctx);
  const running = add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  const queued = add(ctx, 'ABC1', 'b');
  ctx.freeGb = () => -1;
  writeLog(ctx, running, OK);
  alive.clear();
  await tick(ctx, NOW + 10000);
  assert.deepEqual(states(ctx, running, queued), ['done', 'queued']);
  assert.equal(calls.length, 1);
  assert.deepEqual(h.logs('intake').map(l => l.open), [true, false]);
});

test('a throwing project does not stop another project\'s job from starting', async t => {
  const h = makeHome(t, ['ABC1', 'DEF2', 'GHI3']);
  const ctx = h.context();
  fakeWorkers(ctx);
  const real = ctx.rulesFor;
  ctx.rulesFor = key => { if (key === 'ABC1') throw new Error('hỏng'); return real(key); };
  ctx.handlers = { probe: { prepare: job => { if (job.project === 'DEF2') throw new Error('không dựng được'); return { prompt: 'p', cwd: h.root }; } } };
  const [a, b, c] = ['ABC1', 'DEF2', 'GHI3'].map(key => add(ctx, key, 'x'));
  await tick(ctx, NOW);
  assert.deepEqual(states(ctx, a, b, c), ['queued', 'parked', 'running']);
  assert.equal(jobs.getJob(ctx.db, b).parkReason, 'không dựng được');
  assert.equal(h.logs('project-error')[0].project, 'ABC1');
});

test('invalid project config: its queued jobs stay queued, others run', async t => {
  const h = makeHome(t, ['ABC1', 'DEF2']);
  h.project('ABC1', { repo: 'sai' });
  const ctx = h.context();
  fakeWorkers(ctx);
  const [a, b] = ['ABC1', 'DEF2'].map(key => add(ctx, key, 'x'));
  await tick(ctx, NOW);
  await tick(ctx, NOW + 10000);
  assert.deepEqual(states(ctx, a, b), ['queued', 'running']);
  assert.equal(h.logs('project-config').length, 1);
});

test('a disabled, a paused and an unknown project start nothing', async t => {
  const h = makeHome(t, ['ABC1', 'DEF2']);
  h.project('ABC1', { enabled: false });
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  health.setProjectState(ctx.db, 'DEF2', { paused: true });
  for (const key of ['ABC1', 'DEF2', 'NOPE9']) add(ctx, key, 'x');
  await tick(ctx, NOW);
  assert.equal(calls.length, 0);
});

test('an invalid rule file keeps the last good rules; with no good rules nothing starts', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  const file = path.join(h.rulesDir, 'default.yaml');
  const good = fs.readFileSync(file);
  add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  fs.writeFileSync(file, 'rules: [');
  add(ctx, 'ABC1', 'b');
  await tick(ctx, NOW + 10000);
  assert.equal(calls.length, 2);
  assert.equal(h.logs('rules').length, 1);
  const fresh = h.context();
  const other = fakeWorkers(fresh);
  fresh.deps.isSameProcess = () => true;
  add(fresh, 'ABC1', 'c');
  jobs.finish(fresh.db, 1, 'done', null, NOW);
  await tick(fresh, NOW + 20000);
  assert.equal(other.calls.length, 0);
  fs.writeFileSync(file, good);
  await tick(fresh, NOW + 30000);
  assert.equal(other.calls.length, 1);
});

test('a job requeued by X01 is not reclaimed before the reset, also after a restart', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls, alive } = fakeWorkers(ctx);
  const id = add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  writeLog(ctx, id, rejected(NOW / 1000 + 3600));
  alive.clear();
  await tick(ctx, NOW + 10000);
  assert.deepEqual(states(ctx, id), ['queued']);
  const again = h.context();
  const later = fakeWorkers(again);
  await tick(again, NOW + 59 * MIN);
  assert.equal(calls.length + later.calls.length, 1);
  assert.equal(decisions(again, 'X01')[0].action, 'requeued');
  await tick(again, NOW + 61 * MIN);
  assert.equal(later.calls.length, 1);
});

test('a stopping service claims nothing and sends nothing', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  ctx.stopping = true;
  add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  assert.equal(calls.length, 0);
});

test('only the first tick treats a job that never got a pid as left over from a restart', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  fakeWorkers(ctx);
  ctx.freeGb = () => -1;
  const claim = key => {
    add(ctx, 'ABC1', key);
    return jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW }).id;
  };
  const first = claim('a');
  await tick(ctx, NOW);
  assert.deepEqual(states(ctx, first), ['queued']);
  assert.equal(decisions(ctx, 'X04')[0].action, 'requeued');
  jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW });
  await tick(ctx, NOW + 10000);
  assert.deepEqual(states(ctx, first), ['starting']);
});
