const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const jobs = require('../src/jobs.cjs');
const { openDb } = require('../src/db.cjs');
const { supervise } = require('../src/supervisor.cjs');
const { world, ev, rulesFor, NOW, MIN } = require('./supervisor-fixtures.cjs');

const pass = (w, extra = {}) => supervise(w.db, { rulesFor, deps: w.deps, now: NOW, boot: false, ...extra });
const kinds = out => out.actions.map(a => [a.jobId, a.type, a.code]);

test('crash between claim and spawn: job is claimed again exactly once', async () => {
  const w = world();
  const id = w.add('x');
  const first = w.claim();
  w.reopen();
  assert.deepEqual(kinds(await pass(w, { boot: true })), [[id, 'requeued', 'X04']]);
  const again = w.claim();
  assert.equal(again.id, id);
  assert.equal(again.attempt, 2);
  assert.equal(again.resume, false);
  assert.notEqual(again.sessionId, first.sessionId);
  assert.equal(w.claim(), null);
});

test('crash before the spawn of a resumed attempt keeps the session to resume', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.text(1));
  w.die(job);
  await pass(w);
  w.claim();
  w.reopen();
  await pass(w, { boot: true });
  const again = w.claim();
  assert.deepEqual([again.resume, again.sessionId, again.resumes], [true, job.sessionId, 1]);
});

test('crash between spawn and markRunning: the live worker is adopted, no second one', async () => {
  const w = world();
  const id = w.add('x');
  const job = w.claim();
  const started = w.spawn(job);
  w.reopen();
  assert.deepEqual(kinds(await pass(w, { boot: true })), [[id, 'adopted', 'X04']]);
  assert.equal(w.job(id).pid, started.pid);
  assert.equal(w.job(id).attempt, 1);
  assert.equal(w.claim(), null);
  assert.deepEqual(kinds(await pass(w)), []);
});

test('reboot: pid alive but different start time → treated as dead, no signal sent', async () => {
  const w = world();
  const job = w.run('x');
  w.alive.set(job.pid, 'another start');
  assert.deepEqual(kinds(await pass(w, { boot: true, now: NOW + 300 * MIN })), [[job.id, 'resumed', 'X02']]);
  assert.deepEqual(w.calls.stop, []);
});

test('service restarted while the worker runs: reattaches by offset, no second worker, events not double-counted', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.text(1), ev.quota('allowed', 0.3));
  await pass(w);
  const offset = w.job(job.id).logOffset;
  w.reopen();
  w.log(job.id, ev.text(2));
  w.calls.read.length = 0;
  const out = await pass(w, { boot: true, now: NOW + MIN });
  assert.deepEqual(out, { actions: [], quota: null, quotas: [] });
  assert.equal(w.calls.read[0], offset);
  assert.equal(w.calls.read.includes(0), false);
  const now = w.job(job.id);
  assert.deepEqual([now.state, now.pid, now.attempt, now.lastEventAt], ['running', job.pid, 1, NOW + MIN]);
  assert.equal(now.logOffset, fs.statSync(job.logFile).size);
  await pass(w, { now: NOW + 2 * MIN });
  assert.equal(w.job(job.id).lastEventAt, NOW + MIN);
  assert.equal(w.claim(), null);
});

test('worker finished while the service was down → done', async () => {
  const w = world();
  const job = w.run('x');
  w.reopen();
  w.log(job.id, ev.text(1), ev.ok({ result: 'kết quả' }));
  w.die(job);
  assert.deepEqual(kinds(await pass(w, { boot: true })), [[job.id, 'done', null]]);
  assert.equal(w.job(job.id).result.text, 'kết quả');
});

test('two resumes are never issued when supervise runs twice in a row', async () => {
  const w = world();
  const job = w.run('x');
  const five = () => ({ rules: { X02: { silent_minutes: 30, max_resumes: 5 } } });
  w.die(job);
  const other = openDb(w.file);
  const first = await pass(w, { rulesFor: five });
  const second = await supervise(other, { rulesFor: five, deps: w.deps, now: NOW, boot: true });
  assert.deepEqual(kinds(first), [[job.id, 'resumed', 'X02']]);
  assert.deepEqual(second.actions, []);
  assert.equal(w.job(job.id).resumes, 1);
});

test('two overlapping passes stopping the same silent worker take one turn and leave the next attempt alone', async () => {
  const w = world();
  const job = w.run('x');
  const five = () => ({ rules: { X02: { silent_minutes: 30, max_resumes: 5 } } });
  const gates = [];
  w.deps.stopWorker = () => new Promise(resolve => gates.push(resolve));
  const later = { rulesFor: five, now: NOW + 40 * MIN };
  const one = pass(w, later);
  const two = pass(w, later);
  gates[0](true);
  assert.deepEqual(kinds(await one), [[job.id, 'resumed', 'X02']]);
  const again = w.claim(NOW + 40 * MIN);
  jobs.markRunning(w.db, again.id, { ...w.spawn(again), sessionId: again.sessionId, logFile: w.deps.logFileFor(again) }, NOW + 40 * MIN);
  gates[1](true);
  assert.deepEqual((await two).actions, []);
  assert.deepEqual([w.job(job.id).state, w.job(job.id).resumes, w.job(job.id).attempt], ['running', 1, 2]);
});

test('a worker that cannot be stopped stays running and is retried on the next pass', async () => {
  for (const stopWorker of [async () => false, async () => { throw new Error('ps hỏng'); }]) {
    const w = world();
    const job = w.run('x');
    const good = w.deps.stopWorker;
    w.deps.stopWorker = stopWorker;
    const now = NOW + 30 * MIN;
    assert.deepEqual(kinds(await pass(w, { now })), [[job.id, 'stop-failed', 'X02']]);
    assert.deepEqual([w.job(job.id).state, w.job(job.id).resumes], ['running', 0]);
    w.deps.stopWorker = good;
    assert.deepEqual(kinds(await pass(w, { now })), [[job.id, 'resumed', 'X02']]);
  }
});

test('a failed probe never concludes dead, for running and for starting jobs', async () => {
  const w = world();
  const running = w.run('x');
  const id = w.add('y');
  w.claim();
  const fail = () => { throw new Error('ps hỏng'); };
  Object.assign(w.deps, { isSameProcess: fail, findWorkerBySession: fail });
  const out = await pass(w, { boot: true, now: NOW + 300 * MIN });
  assert.deepEqual(kinds(out), [[running.id, 'probe-failed', null], [id, 'probe-failed', null]]);
  assert.match(out.actions[0].error, /ps hỏng/);
  assert.equal(w.job(running.id).state, 'running');
  assert.equal(w.job(id).state, 'starting');
  assert.deepEqual(w.calls.stop, []);
});

test('one job throwing does not stop supervision of the others', async () => {
  const w = world();
  const broken = w.run('x', 'a');
  const fine = w.run('y', 'b');
  w.die(broken);
  w.die(fine);
  const perProject = project => { if (project === 'a') throw new Error('rule hỏng'); return rulesFor(); };
  const out = await pass(w, { rulesFor: perProject });
  assert.deepEqual(kinds(out), [[broken.id, 'error', null], [fine.id, 'resumed', 'X02']]);
  assert.match(out.actions[0].error, /rule hỏng/);
  assert.equal(w.job(broken.id).state, 'running');
});

test('a missing or emptied log is not activity', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.text(1));
  await pass(w);
  fs.truncateSync(job.logFile, 0);
  await pass(w, { now: NOW + 10 * MIN });
  fs.rmSync(job.logFile);
  await pass(w, { now: NOW + 20 * MIN });
  assert.equal(w.job(job.id).lastEventAt, NOW);
});
