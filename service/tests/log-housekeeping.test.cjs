const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const worker = require('../src/worker.cjs');
const { makeHome, add, fakeWorkers, NOW, MIN } = require('./service-fixtures.cjs');

const DAY = 24 * 60 * MIN;

function quiet(t) {
  const h = makeHome(t);
  const ctx = h.context();
  fakeWorkers(ctx);
  ctx.freeGb = () => -1;
  const limits = ctx.rulesFor().limits;
  const claim = key => {
    add(ctx, 'ABC1', key);
    return jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: { ...limits, code_agents_off: 20 }, now: NOW });
  };
  const write = (name, age) => {
    const file = path.join(h.dzHome, 'logs', name);
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, (NOW - age) / 1000, (NOW - age) / 1000);
    return name;
  };
  const left = () => fs.readdirSync(path.join(h.dzHome, 'logs')).filter(n => /^\d/.test(n)).sort();
  return { h, ctx, claim, write, left };
}

test('worker logs of finished jobs older than 30 days are pruned, everything else stays', async t => {
  const { h, ctx, claim, write, left } = quiet(t);
  ctx.boot = false;
  const name = (job, attempt = 1) => `${job.id}-${attempt}-abcdef12.jsonl`;
  const [done, failed, parked, running] = ['a', 'b', 'c', 'd'].map(claim);
  jobs.finish(ctx.db, done.id, 'done', null, NOW);
  jobs.finish(ctx.db, failed.id, 'failed', null, NOW);
  jobs.park(ctx.db, parked.id, 'x', NOW);
  jobs.markRunning(ctx.db, running.id, { pid: 900500, pidStart: 's', sessionId: 's', logFile: path.join(h.dzHome, 'logs', name(running)) }, NOW);
  ctx.deps.isSameProcess = () => true;
  for (const job of [done, failed, parked, running]) write(name(job), 31 * DAY);
  const young = write(name(done, 2), 29 * DAY);
  const unknown = write('999-1-abcdef12.jsonl', 31 * DAY);
  fs.writeFileSync(path.join(h.dzHome, 'logs', 'launchd.out.log'), '');
  fs.utimesSync(path.join(h.dzHome, 'logs', 'launchd.out.log'), 1, 1);
  await tick(ctx, NOW);
  assert.deepEqual(left(), [young, name(parked), name(running), unknown].sort());
  assert.ok(fs.existsSync(path.join(h.dzHome, 'logs', 'launchd.out.log')));
  assert.equal(h.logs('logs-pruned')[0].count, 2);
});

test('pruning runs once a day, also after a restart', async t => {
  const { h, ctx, claim, write, left } = quiet(t);
  const job = claim('a');
  jobs.finish(ctx.db, job.id, 'done', null, NOW);
  const now = NOW - 10 * 60 * MIN;
  await tick(ctx, now);
  const file = write(`${job.id}-1-abcdef12.jsonl`, 40 * DAY);
  await tick(ctx, now + 10000);
  const again = h.context();
  fakeWorkers(again);
  again.freeGb = () => -1;
  await tick(again, now + 20000);
  assert.deepEqual(left(), [file]);
  await tick(again, now + DAY);
  assert.deepEqual(left(), []);
});

test('a worker that cannot be opened leaves no empty log, and an earlier non-empty log is kept', t => {
  const { h } = quiet(t);
  const logFile = path.join(h.root, 'w', 'l.jsonl');
  const start = extra => worker.startWorker({ bin: path.join(h.root, 'nope'), args: [], env: process.env, cwd: h.root, logFile, ...extra });
  assert.throws(() => start(), /nope/);
  assert.throws(() => start({ bin: process.execPath, cwd: path.join(h.root, 'gone') }), /gone/);
  assert.throws(() => start({ args: ['a\0b'] }));
  assert.equal(fs.existsSync(logFile), false);
  fs.writeFileSync(logFile, 'cũ');
  assert.throws(() => start(), /nope/);
  assert.equal(fs.readFileSync(logFile, 'utf8'), 'cũ');
});

test('repeated stop-failed, probe-failed and error lines: once per job and message per 10 minutes', async t => {
  const cases = {
    'stop-failed': deps => { deps.isSameProcess = () => true; },
    'probe-failed': (deps, error) => { deps.isSameProcess = () => { throw new Error(error()); }; },
    error: (deps, error) => { deps.isSameProcess = () => false; deps.readEvents = () => { throw new Error(error()); }; },
  };
  for (const [type, arrange] of Object.entries(cases)) {
    const { h, ctx, claim } = quiet(t);
    ctx.boot = false;
    let message = 'hỏng';
    arrange(ctx.deps, () => message);
    ctx.deps.stopWorker = async () => { throw new Error(message); };
    const run = job => jobs.markRunning(ctx.db, job.id, { pid: 900500 + job.id, pidStart: 's', sessionId: 's', logFile: path.join(h.dzHome, 'logs', 'khong-co') }, NOW - 120 * MIN);
    run(claim('a'));
    run(claim('b'));
    const lines = () => h.logs('supervise').filter(l => l.type === type).length;
    for (let i = 0; i < 59; i++) await tick(ctx, NOW + i * 10000);
    assert.equal(lines(), 2, type);
    message = 'khác';
    await tick(ctx, NOW + 59 * 10000);
    assert.equal(lines(), 4, type);
    message = 'hỏng';
    await tick(ctx, NOW + 10 * MIN);
    assert.equal(lines(), 6, type);
  }
});
