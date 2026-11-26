const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { supervise, defaultDeps } = require('../src/supervisor.cjs');
const worker = require('../src/worker.cjs');
const { world, ev, rulesFor, NOW, MIN } = require('./supervisor-fixtures.cjs');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function launch(w, deps, job, script) {
  const env = { ...process.env, FAKE_CLAUDE_SCRIPT: JSON.stringify(script) };
  return worker.startWorker({ bin: process.execPath, args: [FAKE, '--session-id', job.sessionId], env, cwd: w.dir, logFile: deps.logFileFor(job) });
}

test('a real worker forgotten by the service is adopted, followed and finished', async t => {
  const w = world();
  const deps = defaultDeps(w.dir);
  const id = w.add('x');
  const job = w.claim();
  assert.equal(deps.logFileFor(job), path.join(w.dir, 'logs', `${id}-1-${job.sessionId.slice(0, 8)}.jsonl`));
  const print = e => ({ print: JSON.stringify(e) });
  const started = launch(w, deps, job, [print(ev.quota('allowed', 0.2)), { sleep: 2500 }, print(ev.ok({ result: 'thật' }))]);
  t.after(() => { try { process.kill(-started.pid, 'SIGKILL'); } catch {} });
  w.reopen();
  const opts = { rulesFor, deps, now: NOW, boot: true };
  assert.deepEqual((await supervise(w.db, opts)).actions.map(a => a.type), ['adopted']);
  assert.deepEqual([w.job(id).pid, w.job(id).pidStart], [started.pid, started.pidStart]);
  let quota = null;
  const end = Date.now() + 15000;
  while (w.job(id).state === 'running' && Date.now() < end) {
    quota = (await supervise(w.db, { ...opts, boot: false })).quota ?? quota;
    await sleep(100);
  }
  assert.equal(w.job(id).state, 'done');
  assert.equal(w.job(id).result.text, 'thật');
  assert.equal(quota.utilization, 0.2);
  assert.equal(w.job(id).attempt, 1);
});

test('a real silent worker is stopped before its job is requeued', async t => {
  const w = world();
  const deps = defaultDeps(w.dir);
  const id = w.add('x');
  const job = w.claim();
  const started = launch(w, deps, job, [{ print: JSON.stringify(ev.text(1)) }, { sleep: 60000 }]);
  t.after(() => { try { process.kill(-started.pid, 'SIGKILL'); } catch {} });
  await supervise(w.db, { rulesFor, deps, now: NOW, boot: true });
  for (let i = 0; i < 100 && w.job(id).logOffset === 0; i++) {
    await sleep(50);
    await supervise(w.db, { rulesFor, deps, now: NOW, boot: false });
  }
  const out = await supervise(w.db, { rulesFor, deps, now: NOW + 30 * MIN, boot: false });
  assert.deepEqual(out.actions.map(a => a.type), ['resumed']);
  assert.equal(worker.isSameProcess(started.pid, started.pidStart), false);
  assert.equal(w.job(id).sessionId, job.sessionId);
  assert.equal(w.job(id).resume, true);
});
