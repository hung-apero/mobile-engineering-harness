const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jobs = require('../src/jobs.cjs');
const kv = require('../src/kv.cjs');
const health = require('../src/health.cjs');
const { syncParked, trackBlock } = require('../src/blocks.cjs');
const { failuresKey } = require('../src/launch.cjs');
const { runService } = require('../src/run.cjs');
const { lockOwner } = require('../src/service-lock.cjs');
const { isSameProcess, processStart } = require('../src/worker.cjs');
const { makeHome, add, waitFor, sleep, line, writeScript, OK, NOW, MIN } = require('./service-fixtures.cjs');

const jobId = out => Number(out.match(/#(\d+)/)[1]);
const waits = ctx => ctx.db.prepare('SELECT state FROM waits').all().map(w => w.state);

function runningJob(h, id) {
  const ctx = h.context();
  return waitFor(() => {
    const job = jobs.getJob(ctx.db, id);
    return job.state === 'running' && job;
  }, 15000);
}

test('second dz run exits 1 naming the running pid; a stale lock is taken over', async t => {
  const h = makeHome(t);
  const lock = path.join(h.dzHome, 'service.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, pidStart: 'Mon Jan  1 00:00:00 2001' }), { mode: 0o600 });
  const first = h.run();
  await waitFor(() => lockOwner(lock)?.pid === first.pid, 15000);
  const second = h.run();
  const ended = await second.done;
  assert.equal(ended.code, 1);
  assert.match(second.output, new RegExp(`pid ${first.pid}`));
  assert.doesNotMatch(second.output, /\n\s+at /);
  assert.match(h.dz('status').stdout, new RegExp(`đang chạy \\(pid ${first.pid}\\)`));
  first.kill('SIGINT');
  assert.deepEqual(await first.done, { code: 0, signal: null });
  assert.equal(fs.existsSync(lock), false);
});

test('SIGTERM leaves the worker alive; the next dz run reattaches', async t => {
  const h = makeHome(t, ['ABC1'], [{ sleep: 8000 }, line(OK)]);
  const id = jobId(h.dz('probe', 'ABC1').stdout);
  const first = h.run();
  const job = await runningJob(h, id);
  first.kill('SIGTERM');
  assert.deepEqual(await first.done, { code: 0, signal: null });
  assert.ok(isSameProcess(job.pid, job.pidStart));
  const second = h.run();
  await waitFor(() => h.logs('service-started').length === 2);
  const ctx = h.context();
  await waitFor(() => jobs.getJob(ctx.db, id).state === 'done', 30000);
  const done = jobs.getJob(ctx.db, id);
  assert.deepEqual([done.attempt, done.pid, done.result.text], [1, job.pid, 'OK']);
  assert.equal(h.logs('job-started').length, 1);
  second.kill('SIGTERM');
  assert.equal((await second.done).code, 0);
});

test('dz probe ABC1 twice while open prints the same job id', t => {
  const h = makeHome(t);
  const [one, two] = [h.dz('probe', 'ABC1'), h.dz('probe', 'ABC1')];
  assert.equal(one.status, 0);
  assert.equal(jobId(one.stdout), jobId(two.stdout));
  const job = jobs.getJob(h.context().db, jobId(one.stdout));
  assert.deepEqual([job.kind, job.key, job.slots, job.priority, job.project], ['probe', 'probe', 1, 1, 'ABC1']);
});

test('status and doctor never print a secret', t => {
  const h = makeHome(t);
  h.webhook('ABC1', 'https://discord.com/api/webhooks/42/SIEUBIMAT');
  const ctx = h.context();
  const id = add(ctx, 'ABC1', 'x');
  jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW });
  jobs.park(ctx.db, id, 'hỏng https://discord.com/api/webhooks/42/SIEUBIMAT nguoi@congty.vn', NOW);
  const status = h.dz('status');
  assert.equal(status.status, 0);
  assert.match(status.stdout, /ABC1/);
  assert.match(status.stdout, /đang gác/);
  const bin = path.join(h.root, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(h.dzHome, 'claude'));
  for (const name of ['claude', 'gh', 'adb', 'pmset']) {
    writeScript(path.join(bin, name), 'echo "2.1.332 SIEUBIMAT nguoi@congty.vn"; echo "SIEUBIMAT" >&2');
  }
  h.env.PATH = `${bin}:/usr/bin:/bin`;
  h.env.DZ_CLAUDE_BIN = path.join(bin, 'claude');
  const doctor = h.dz('doctor');
  assert.match(doctor.stdout, /ĐẠT gh/);
  for (const text of [status.stdout, status.stderr, doctor.stdout, doctor.stderr]) {
    assert.doesNotMatch(text, /SIEUBIMAT|congty/);
  }
});

test('status works while the config and the rules are broken', t => {
  const h = makeHome(t);
  h.project('ABC1', { repo: 'sai' });
  fs.writeFileSync(path.join(h.rulesDir, 'default.yaml'), 'rules: [');
  const out = h.dz('status');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /không chạy/);
  assert.match(out.stdout, /ABC1\.yaml/);
  assert.match(out.stdout, /default\.yaml/);
});

test('retry requeues a parked job, resolves its wait and forgets start failures', t => {
  const h = makeHome(t);
  const ctx = h.context();
  const id = add(ctx, 'ABC1', 'x');
  assert.equal(h.dz('retry', String(id)).status, 1);
  jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW });
  jobs.park(ctx.db, id, 'x', NOW);
  syncParked(ctx.db, NOW);
  kv.set(ctx.db, failuresKey(id), 2, NOW);
  assert.deepEqual(waits(ctx), ['open']);
  assert.equal(h.dz('retry', String(id)).status, 0);
  assert.equal(jobs.getJob(ctx.db, id).state, 'queued');
  assert.deepEqual(waits(ctx), ['resolved']);
  assert.equal(kv.get(ctx.db, failuresKey(id)), null);
  const missing = h.dz('retry', '999');
  assert.equal(missing.status, 1);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
});

test('pause and resume change the project; resume also resolves the block wait', t => {
  const h = makeHome(t);
  const ctx = h.context();
  assert.equal(h.dz('pause', 'ABC1').status, 0);
  assert.equal(health.isPaused(ctx.db, 'ABC1'), true);
  for (const key of ['a', 'b', 'c']) {
    const id = add(ctx, 'ABC1', key);
    jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW });
    jobs.finish(ctx.db, id, 'failed', null, Date.now() - MIN);
  }
  assert.equal(trackBlock(ctx.db, 'ABC1', ctx.rulesFor('ABC1'), Date.now()), true);
  assert.equal(h.dz('resume', 'ABC1').status, 0);
  assert.equal(health.isPaused(ctx.db, 'ABC1'), false);
  assert.deepEqual(waits(ctx), ['resolved']);
  assert.equal(trackBlock(ctx.db, 'ABC1', ctx.rulesFor('ABC1'), Date.now()), false);
  for (const command of ['probe', 'pause', 'resume']) assert.equal(h.dz(command, 'NOPE9').status, 1);
});

test('unknown command or arguments print the usage and exit 2', t => {
  const h = makeHome(t);
  const bad = [[], ['x'], ['status', 'x'], ['run', 'x'], ['doctor', 'x'], ['probe'], ['probe', 'abc'], ['probe', 'ABC1', 'x'], ['retry'], ['retry', 'a'], ['retry', '1e3'], ['pause'], ['resume', '../x']];
  for (const args of bad) {
    const out = h.dz(...args);
    assert.equal(out.status, 2, args.join(' '));
    assert.match(out.stderr, /Cách dùng/);
    assert.equal(out.stdout, '');
  }
});

test('ticks never overlap and a slow tick is given up after the stop limit', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  let running = 0;
  let most = 0;
  let count = 0;
  const signals = new Map();
  const on = (name, fn) => signals.set(name, fn);
  const tickFn = async () => {
    most = Math.max(most, ++running);
    if (++count === 3) {
      setTimeout(() => signals.get('SIGTERM')(), 10);
      await new Promise(() => {});
    }
    await sleep(40);
    running--;
    if (count === 2) throw new Error('một nhịp hỏng');
  };
  const began = Date.now();
  assert.equal(await runService(ctx, { tickMs: 5, stopWaitMs: 100, tickFn, on }), 0);
  assert.ok(Date.now() - began < 5000);
  assert.deepEqual([most, count], [1, 3]);
  assert.equal(fs.existsSync(ctx.lockFile), false);
});

test('a service that lost its lock stops and leaves the new lock alone', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const other = JSON.stringify({ pid: process.ppid, pidStart: processStart(process.ppid) });
  const tickFn = async () => fs.writeFileSync(ctx.lockFile, other);
  assert.equal(await runService(ctx, { tickMs: 5, tickFn, on: () => {} }), 1);
  assert.equal(fs.readFileSync(ctx.lockFile, 'utf8'), other);
});
