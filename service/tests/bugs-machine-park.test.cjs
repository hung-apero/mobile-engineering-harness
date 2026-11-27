const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup, BRANCH } = require('./bugs-machine-fixtures.cjs');

const DEVICES = fs.readFileSync(path.join(__dirname, 'bugs-cleanup.test.cjs'), 'utf8').match(/const DEVICES = `([\s\S]*?)`;/)[1];

function locks(s, holders) {
  const scripts = path.join(s.dzHome, 'harness', 'skills', 'bug-fix', 'scripts');
  const state = path.join(s.dzHome, 'bug-fix-state');
  for (const dir of [scripts, state]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'devices.py'), DEVICES);
  const file = path.join(state, 'devices.json');
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(holders).map(([serial, holder]) => [serial, { holder, since: 1 }]))));
  return () => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));
}

for (const [kind, state] of [['bug', 'failed'], ['bug', 'parked'], ['review', 'parked']]) {
  test(`a ${state} ${kind} job parks the batch`, async t => {
    const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'], kinds: { [kind]: () => state } });
    const id = await s.open();
    assert.equal((await s.until(id)).state, 'abandoned');
    assert.equal(s.batch(id).data.phase, 'parked');
    assert.deepEqual(['AAP1-1', 'AAP1-2'].map(key => s.ticket(key).state), ['dev', 'dev']);
    assert.equal(s.waits('dev').length, 1);
    assert.equal(s.comments('AAP1-1').length, 1);
    assert.deepEqual(s.fake.issues['AAP1-1'].labels, []);
    assert.ok(fs.existsSync(s.repo(id)));
  });
}

test('a parked batch releases only its own locks and stops only its own processes', async t => {
  const s = setup(t, { kinds: { bug: job => {
    s.child = spawn('/bin/sleep', ['60'], { cwd: s.repo(job.payload.batchId), stdio: 'ignore' });
    s.gone = new Promise(resolve => s.child.on('exit', (code, signal) => resolve(signal)));
    return 'failed';
  } } });
  const other = spawn('/bin/sleep', ['60'], { cwd: s.dzHome, stdio: 'ignore' });
  t.after(() => [s.child, other].forEach(child => child.kill('SIGKILL')));
  const id = await s.open();
  const left = locks(s, { A: `batch:${id}:J1`, B: `batch:${id}1:J1`, C: 'note:BUG-1' });
  await s.until(id);
  assert.deepEqual(left(), ['B', 'C']);
  assert.equal(await s.gone, 'SIGTERM');
  assert.equal(other.exitCode ?? other.signalCode, null);
});

test('locks are released even while Jira is down, and parking finishes later', async t => {
  const s = setup(t, { kinds: { bug: () => 'failed' } });
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'parked');
  const left = locks(s, { A: `batch:${id}:J1` });
  s.before['jira.comment'] = () => { throw new Error('Jira 503'); };
  await s.advance(id);
  assert.deepEqual(left(), []);
  assert.equal(s.waits('dev').length, 1);
  delete s.before['jira.comment'];
  assert.equal((await s.until(id)).state, 'abandoned');
  assert.equal(s.waits('dev').length, 1);
});

test('a failed distribution parks the batch, keeps the pushed branch and does not resolve', async t => {
  const s = setup(t, { kinds: { distributeOk: false } });
  const id = await s.open();
  assert.equal((await s.until(id)).state, 'abandoned');
  assert.ok(s.codes().includes('Q04 distribute-failed'));
  assert.equal(s.ref(BRANCH, s.github), s.ref(BRANCH));
  assert.equal(s.fake.issues['AAP1-1'].status, 'To Do');
  assert.equal(s.ticket('AAP1-1').state, 'dev');
  assert.doesNotMatch(s.comments('AAP1-1')[0], /Đã sửa/);
});

test('a live project without a distribute command is parked, not resolved', async t => {
  const s = setup(t, { commands: { distribute: undefined } });
  assert.equal((await s.until(await s.open())).state, 'abandoned');
});

test('a crash in the middle of parking does not duplicate the comment or the wait', async t => {
  for (const point of ['cleanup.stopProcesses', 'cleanup.releaseDevices', 'jira.comment', 'jira.removeLabels', 'jira.transition', 'landing.resetVersion']) {
    const s = setup(t, { kinds: { gate: () => 'failed' } });
    const id = await s.open();
    await s.until(id, b => b.data.phase === 'parked');
    s.boom = point;
    assert.equal((await s.until(id)).state, 'abandoned', point);
    assert.equal(s.comments('AAP1-1').length, 1, point);
    assert.equal(s.waits('dev').length, 1, point);
    assert.equal(s.ref(BRANCH), s.batch(id).data.before, point);
  }
});

test('a finished batch is never advanced again', async t => {
  const s = setup(t, { kinds: { bug: () => 'failed' } });
  const id = await s.open();
  await s.until(id);
  assert.deepEqual(await s.advance(id), { changed: false, phase: 'parked' });
});
