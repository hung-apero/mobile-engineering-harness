const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const jobs = require('../src/jobs.cjs');
const { readEvents } = require('../src/stream-reader.cjs');
const { supervise } = require('../src/supervisor.cjs');
const { world, ev, rulesFor, NOW, MIN } = require('./supervisor-fixtures.cjs');

const pass = (w, extra = {}) => supervise(w.db, { rulesFor, deps: w.deps, now: NOW, boot: false, ...extra });
const kinds = out => out.actions.map(a => [a.jobId, a.type, a.code]);

test('starting without a pid and its process found → adopted with markRunning (X04)', async () => {
  const w = world();
  const id = w.add('x');
  const job = w.claim();
  const started = w.spawn(job);
  const out = await pass(w);
  assert.deepEqual(kinds(out), [[id, 'adopted', 'X04']]);
  const now = w.job(id);
  assert.equal(now.state, 'running');
  assert.deepEqual([now.pid, now.pidStart, now.sessionId, now.logFile], [started.pid, started.pidStart, job.sessionId, w.deps.logFileFor(job)]);
});

test('starting without a process → requeued after 60 seconds or at once on boot (X04)', async () => {
  const w = world();
  const id = w.add('x');
  w.claim();
  assert.deepEqual(kinds(await pass(w, { now: NOW + 60000 })), []);
  assert.deepEqual(kinds(await pass(w, { now: NOW + 60001 })), [[id, 'requeued', 'X04']]);
  assert.equal(w.job(id).state, 'queued');
  w.claim(NOW + 70000);
  assert.deepEqual(kinds(await pass(w, { now: NOW + 70000 })), []);
  assert.deepEqual(kinds(await pass(w, { now: NOW + 70000, boot: true })), [[id, 'requeued', 'X04']]);
  assert.equal(w.job(id).resumes, 0);
});

test('running with a growing log → offset, last event and quota updated, no action', async () => {
  const w = world();
  const { id, logFile } = w.run('x');
  w.log(id, ev.text(1), ev.quota('allowed', 0.4));
  const out = await pass(w, { now: NOW + MIN });
  assert.deepEqual(out.actions, []);
  assert.deepEqual(out.quota, { utilization: 0.4, resetsAt: 1796018400, status: 'allowed' });
  assert.equal(w.job(id).logOffset, fs.statSync(logFile).size);
  assert.equal(w.job(id).lastEventAt, NOW + MIN);
  assert.equal((await pass(w)).quota, null);
});

test('running but silent → stopped and resumed, then parked when no turn is left (X02)', async () => {
  const w = world();
  const first = w.run('x');
  w.log(first.id, ev.text(1));
  await pass(w);
  const out = await pass(w, { now: NOW + 30 * MIN });
  assert.deepEqual(kinds(out), [[first.id, 'resumed', 'X02']]);
  assert.equal(out.actions[0].project, 'a');
  assert.deepEqual(w.calls.stop, [[first.pid, first.pidStart, 10000]]);
  let job = w.job(first.id);
  assert.deepEqual([job.state, job.resume, job.resumes, job.sessionId], ['queued', true, 1, first.sessionId]);
  const again = w.claim(NOW + 31 * MIN);
  jobs.markRunning(w.db, again.id, { ...w.spawn(again), sessionId: again.sessionId, logFile: w.deps.logFileFor(again) }, NOW + 31 * MIN);
  assert.deepEqual(kinds(await pass(w, { now: NOW + 61 * MIN })), [[first.id, 'parked', 'X02']]);
  job = w.job(first.id);
  assert.equal(job.state, 'parked');
  assert.match(job.parkReason, /^X02: im 30 phút/);
});

test('process gone, last result without error → done', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.text(1), ev.ok());
  w.die(job);
  assert.deepEqual(kinds(await pass(w)), [[job.id, 'done', null]]);
  assert.deepEqual(w.job(job.id).result, { text: 'xong', costUsd: 0.5, turns: 3, denials: [] });
});

test('process gone, quota rejected → requeued with the session, no turn taken (X01)', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.quota('rejected', 1), ev.text(1), ev.bad());
  w.die(job);
  const out = await pass(w);
  assert.deepEqual(kinds(out), [[job.id, 'requeued', 'X01']]);
  assert.equal(out.quota.status, 'rejected');
  const now = w.job(job.id);
  assert.deepEqual([now.state, now.resume, now.resumes, now.sessionId], ['queued', true, 0, job.sessionId]);
});

test('process gone with denials and an error → parked with the blocked commands (X03)', async () => {
  const w = world();
  const job = w.run('x');
  const denials = [{ tool_name: 'Bash', tool_input: { command: 'rm -rf /x' } }];
  w.log(job.id, ev.bad({ permission_denials: denials }));
  w.die(job);
  const out = await pass(w);
  assert.deepEqual(kinds(out), [[job.id, 'parked', 'X03']]);
  assert.deepEqual(out.actions[0].denials, [{ tool_name: 'Bash', command: 'rm' }]);
  assert.equal(w.job(job.id).parkReason, 'X03: lệnh bị chặn: Bash(rm)');
});

test('process gone without a result or with another error → resumed, then failed (X02)', async () => {
  const w = world();
  const job = w.run('x');
  w.die(job);
  assert.deepEqual(kinds(await pass(w)), [[job.id, 'resumed', 'X02']]);
  const again = w.claim();
  const running = jobs.markRunning(w.db, again.id, { ...w.spawn(again), sessionId: again.sessionId, logFile: w.deps.logFileFor(again) }, NOW);
  w.log(job.id, ev.bad());
  w.die(running);
  assert.deepEqual(kinds(await pass(w)), [[job.id, 'failed', 'X02']]);
  assert.equal(w.job(job.id).state, 'failed');
  assert.equal(w.job(job.id).result.error, 'error_during_execution');
});

test('a result event does not finish a job while its process lives', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.ok());
  assert.deepEqual((await pass(w)).actions, []);
  assert.equal(w.job(job.id).state, 'running');
});

test('a dead worker is judged from its whole log, read in bounded chunks', async () => {
  const w = world();
  const job = w.run('x');
  w.deps.readEvents = (file, offset) => readEvents(file, offset, 400);
  w.log(job.id, ...Array.from({ length: 50 }, (_, n) => ev.text(n)), ev.ok());
  await pass(w);
  w.log(job.id, ...Array.from({ length: 50 }, (_, n) => ({ type: 'system', subtype: 'task_updated', n })));
  w.die(job);
  assert.deepEqual(kinds(await pass(w)), [[job.id, 'done', null]]);
});

test('silent limit counts from the last event, not from start', async () => {
  const w = world();
  const { id } = w.run('x');
  w.log(id, ev.text(1));
  await pass(w, { now: NOW + 25 * MIN });
  assert.deepEqual(kinds(await pass(w, { now: NOW + 54 * MIN })), []);
  assert.deepEqual(kinds(await pass(w, { now: NOW + 55 * MIN })), [[id, 'resumed', 'X02']]);
});

test('process gone after losing the API connection → requeued with the session, no resume used (X04)', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.text(1), ev.ok({ is_error: true, api_error: 'connection_failed', result: "API Error: Can't reach the API server (ENOTFOUND)" }));
  w.die(job);
  const out = await pass(w);
  assert.deepEqual(kinds(out), [[job.id, 'requeued', 'X04']]);
  assert.equal(out.actions[0].offline, true);
  const now = w.job(job.id);
  assert.deepEqual([now.state, now.resume, now.resumes], ['queued', true, 0]);
});
