const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const worker = require('../src/worker.cjs');
const { stepHome, alive, RUN_STEP, SESSION } = require('./run-step-fixtures.cjs');
const { waitFor, sleep } = require('./service-fixtures.cjs');

const STUBBORN = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const note = name => `require('fs').writeFileSync('${name}', String(process.pid));`;
const tree = `${STUBBORN} require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`${STUBBORN} ${note('grand')}`)}], { detached: true, stdio: 'ignore' }); ${note('step')}`;
const ready = h => waitFor(() => ['step', 'grand'].every(n => fs.existsSync(h.file(n)) && h.read(n) !== ''));
const marker = h => h.js("require('fs').writeFileSync('next', '')");

test('a timeout kills the whole stubborn process tree and fails the step', async t => {
  const h = stepHome(t);
  const r = await h.run({ steps: [h.js(tree, { timeoutMs: 1500 }), marker(h)] });
  assert.equal(r.code, 1);
  assert.deepEqual(r.steps.map(s => [s.ok, s.timedOut, s.exitCode]), [[false, true, null]]);
  assert.deepEqual(['step', 'grand'].map(n => alive(h.pid(n))), [false, false]);
  assert.equal(fs.existsSync(h.file('next')), false);
});

test('a step that exits 0 on the SIGTERM of its timeout still failed', async t => {
  const h = stepHome(t);
  const r = await h.run({ steps: [h.js("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)", { timeoutMs: 1000 })] });
  assert.deepEqual([r.code, r.steps[0].ok, r.steps[0].timedOut], [1, false, true]);
});

test('SIGTERM kills the running step tree and leaves no result', async t => {
  const h = stepHome(t);
  const child = h.start(h.spec({ steps: [h.js(tree, { retries: 3 }), marker(h)] }));
  await ready(h);
  child.kill('SIGTERM');
  assert.deepEqual(await child.done, { code: 143, signal: null });
  assert.deepEqual(['step', 'grand'].map(n => alive(h.pid(n))), [false, false]);
  assert.equal(h.summary().result, null);
  assert.equal(fs.existsSync(h.file('result.json')), false);
  assert.equal(fs.existsSync(h.file('next')), false);
});

test('a step killed just before run-step is told to stop is not reported as failed', async t => {
  const h = stepHome(t);
  const child = h.start(h.spec({ steps: [h.js(`setInterval(() => {}, 1000); ${note('step')}`)] }));
  await waitFor(() => fs.existsSync(h.file('step')) && h.read('step'));
  process.kill(h.pid('step'), 'SIGTERM');
  await sleep(200);
  child.kill('SIGTERM');
  await child.done;
  assert.equal(h.summary().result, null);
});

test('a step killed from outside is a failed step with its signal', async t => {
  const h = stepHome(t);
  const r = await h.run({ steps: [h.js("process.kill(process.pid, 'SIGKILL')")] });
  assert.deepEqual([r.code, r.steps[0].signal, r.steps[0].exitCode, r.steps[0].timedOut], [1, 'SIGKILL', null, false]);
});

test('the supervisor stop takes run-step and its step tree down', async t => {
  const h = stepHome(t);
  const spec = h.spec({ steps: [h.js(tree)] });
  const started = worker.startWorker({ bin: process.execPath, args: [RUN_STEP, spec, '--session-id', SESSION], env: process.env, cwd: h.dir, logFile: h.file('stream.jsonl') });
  t.after(() => { try { process.kill(-started.pid, 'SIGKILL'); } catch {} });
  await ready(h);
  assert.deepEqual(worker.findWorkerBySession(SESSION), started);
  assert.equal(await worker.stopWorker(started.pid, started.pidStart, 10000), true);
  assert.deepEqual(['step', 'grand'].map(n => alive(h.pid(n))), [false, false]);
  assert.equal(h.summary().result, null);
});
