const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const jobs = require('../src/jobs.cjs');
const { supervise } = require('../src/supervisor.cjs');
const { tick } = require('../src/tick.cjs');
const { bootTime, parseBootTime } = require('../src/boot-time.cjs');
const { world, ev, rulesFor, NOW, MIN } = require('./supervisor-fixtures.cjs');
const { makeHome, add, fakeWorkers } = require('./service-fixtures.cjs');

const HOUR = 60 * MIN;
const pass = (w, extra = {}) => supervise(w.db, { rulesFor, deps: w.deps, now: NOW, boot: false, ...extra });
const kinds = out => out.actions.map(a => [a.jobId, a.type, a.code]);

test('two reboots in a row requeue the same job with its session as X04 and take no resume', async () => {
  const w = world();
  let job = w.run('x');
  const session = job.sessionId;
  for (const day of [1, 2]) {
    w.log(job.id, ev.text(1));
    w.die(job);
    const now = NOW + day * HOUR;
    w.deps.bootTime = () => now - MIN;
    assert.deepEqual(kinds(await pass(w, { now, boot: true })), [[job.id, 'requeued', 'X04']]);
    const back = w.job(job.id);
    assert.deepEqual([back.state, back.resume, back.resumes, back.sessionId], ['queued', true, 0, session]);
    const again = w.claim(now);
    job = jobs.markRunning(w.db, again.id, { ...w.spawn(again), sessionId: again.sessionId, logFile: w.deps.logFileFor(again) }, now);
  }
  assert.equal(job.attempt, 3);
});

test('a reboot before the worker answered starts over with a fresh session, still X04', async () => {
  const w = world();
  const job = w.run('x');
  w.die(job);
  w.deps.bootTime = () => NOW + 1;
  assert.deepEqual(kinds(await pass(w, { boot: true })), [[job.id, 'requeued', 'X04']]);
  const back = w.job(job.id);
  assert.deepEqual([back.resume, back.resumes, back.sessionId], [false, 0, null]);
});

test('a worker that died after the boot is still charged as X02', async () => {
  const w = world();
  const job = w.run('x');
  w.die(job);
  w.deps.bootTime = () => NOW;
  assert.deepEqual(kinds(await pass(w)), [[job.id, 'resumed', 'X02']]);
});

test('work finished, out of quota or blocked before a reboot keeps its own outcome', async () => {
  for (const [events, expected] of [
    [[ev.text(1), ev.ok()], ['done', null]],
    [[ev.quota('rejected'), ev.bad()], ['requeued', 'X01']],
    [[ev.bad({ permission_denials: [{ tool_name: 'Write' }] })], ['parked', 'X03']],
  ]) {
    const w = world();
    const job = w.run('x');
    w.log(job.id, ...events);
    w.die(job);
    w.deps.bootTime = () => NOW + HOUR;
    assert.deepEqual(kinds(await pass(w)), [[job.id, ...expected]]);
  }
});

test('boot time is read from sysctl, close to what the OS reports, and falls back to uptime', () => {
  assert.equal(parseBootTime('{ sec = 1764000000, usec = 250000 } Mon Nov 24 23:00:00 2025\n'), 1764000000250);
  assert.equal(parseBootTime('rác'), null);
  const expected = Date.now() - os.uptime() * 1000;
  assert.ok(Math.abs(bootTime() - expected) < 10000);
  assert.ok(Math.abs(bootTime({ run: () => { throw new Error('hỏng'); } }) - expected) < 10000);
  assert.ok(Math.abs(bootTime({ run: () => 'rác' }) - expected) < 10000);
  let seen;
  bootTime({ run: (file, args, options) => { seen = { file, args, options }; return ''; } });
  assert.equal(seen.file, '/usr/sbin/sysctl');
  assert.deepEqual(seen.args, ['-n', 'kern.boottime']);
  assert.ok(seen.options.timeout > 0 && seen.options.timeout <= 10000);
});

test('silence counts from the wake when that is later than the last event', async () => {
  const w = world();
  const job = w.run('x');
  const wakeAt = NOW + 8 * HOUR;
  assert.deepEqual(kinds(await pass(w, { now: wakeAt + 29 * MIN, wakeAt })), []);
  const out = await pass(w, { now: wakeAt + 30 * MIN, wakeAt });
  assert.deepEqual(kinds(out), [[job.id, 'resumed', 'X02']]);
  assert.equal(out.actions[0].silentMinutes, 30);
});

function sleeper(t) {
  const h = makeHome(t);
  const ctx = h.context();
  fakeWorkers(ctx);
  const stopped = [];
  ctx.deps.stopWorker = async pid => { stopped.push(pid); return true; };
  add(ctx, 'ABC1', 'a');
  return { ctx, stopped };
}

test('an 8 hour gap between ticks stops nothing; genuine silence afterwards does', async t => {
  const { ctx, stopped } = sleeper(t);
  await tick(ctx, NOW);
  for (let m = 0; m < 30; m++) await tick(ctx, NOW + 8 * HOUR + m * MIN);
  assert.deepEqual(stopped, []);
  await tick(ctx, NOW + 8 * HOUR + 30 * MIN);
  assert.equal(stopped.length, 1);
});

test('a gap of exactly two minutes is not a sleep', async t => {
  const { ctx, stopped } = sleeper(t);
  for (let m = 0; m <= 30; m += 2) await tick(ctx, NOW + m * MIN);
  assert.equal(stopped.length, 1);
});
