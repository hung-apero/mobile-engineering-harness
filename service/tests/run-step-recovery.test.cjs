const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { stepHome, alive } = require('./run-step-fixtures.cjs');
const { waitFor, sleep } = require('./service-fixtures.cjs');

const hang = "const fs = require('fs'); fs.appendFileSync('runs', 'x'); if (fs.readFileSync('runs').length === 1) { fs.writeFileSync('step', String(process.pid)); setInterval(() => {}, 1000); }";

async function killedMidStep(h, doc) {
  const child = h.start(h.spec(doc));
  await waitFor(() => fs.existsSync(h.file('step')) && h.read('step') && fs.existsSync(h.file('running.json')));
  child.kill('SIGKILL');
  await child.done;
  const pid = h.pid('step');
  assert.equal(alive(pid), true);
  return pid;
}

test('a step left behind by a killed run-step is stopped before the steps run again', async t => {
  const h = stepHome(t);
  const doc = { steps: [h.js(hang)] };
  const pid = await killedMidStep(h, doc);
  const r = await h.run(doc);
  assert.deepEqual([r.code, h.read('runs'), alive(pid)], [0, 'xx', false]);
  assert.equal(fs.existsSync(h.file('running.json')), false);
});

test('the running record is private and gone when the steps ended', async t => {
  const h = stepHome(t);
  const child = h.start(h.spec({ steps: [h.js("setTimeout(() => {}, 1500)")] }));
  await waitFor(() => fs.existsSync(h.file('running.json')));
  const record = JSON.parse(h.read('running.json'));
  assert.ok(record.pid > 1 && typeof record.start === 'string');
  assert.equal(fs.statSync(h.file('running.json')).mode & 0o777, 0o600);
  await child.done;
  assert.equal(fs.existsSync(h.file('running.json')), false);
});

test('a recorded pid that now belongs to another process is left alone', async t => {
  const h = stepHome(t);
  const other = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  for (const text of [JSON.stringify({ pid: other.pid, start: 'Mon Jan  1 00:00:00 2001' }), '{', 'null']) {
    fs.writeFileSync(h.file('running.json'), text);
    assert.equal((await h.run({ steps: [h.js('')] })).code, 0);
  }
  assert.equal(other.exitCode ?? other.signalCode, null);
});

test('a once step that had started is not repeated, its result is unknown', async t => {
  const h = stepHome(t);
  const doc = { steps: [h.js("require('fs').appendFileSync('build', 'x')", { name: 'assemble' }), h.js(hang, { name: 'distribute', once: true })] };
  await killedMidStep(h, doc);
  const r = await h.run(doc);
  assert.equal(r.code, 1);
  assert.deepEqual([h.read('build'), h.read('runs')], ['xx', 'x']);
  assert.deepEqual([r.steps[1].name, r.steps[1].ok, r.steps[1].unknown, r.steps[1].attempts], ['distribute', false, true, 0]);
});

test('a once step marks its start before it runs and a later failure of it is not repeated either', async t => {
  const h = stepHome(t);
  const doc = { steps: [h.js("require('fs').writeFileSync('seen', String(require('fs').readdirSync('.').some(n => n.endsWith('.started')))); process.exit(3)", { name: 'distribute', once: true })] };
  const first = await h.run(doc);
  assert.deepEqual([h.read('seen'), first.steps[0].exitCode, first.steps[0].unknown], ['true', 3, undefined]);
  fs.rmSync(h.file('seen'));
  assert.equal((await h.run(doc)).steps[0].unknown, true);
  await sleep(10);
  assert.equal(fs.existsSync(h.file('seen')), false);
});

test('once must be a boolean and allows no retry', async t => {
  const h = stepHome(t);
  for (const extra of [{ once: 'yes' }, { once: true, retries: 1 }]) assert.equal((await h.run({ steps: [h.js('', extra)] })).code, 1);
});
