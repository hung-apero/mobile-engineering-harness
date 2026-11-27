const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { g } = require('./bugs-git-fixtures.cjs');
const { memDb } = require('./bugs-fixtures.cjs');
const { releaseDevices, stopProcesses, removeBatchFiles, pruneAbandoned } = require('../src/bugs/cleanup.cjs');

const DEVICES = `
import json, os
from pathlib import Path
FILE = Path(os.environ["BUG_FIX_STATE_DIR"]) / "devices.json"
def snapshot(start=None): return json.loads(FILE.read_text())
def release(serial, holder, start=None):
    data = snapshot()
    if data.get(serial, {}).get("holder") != holder: return False
    del data[serial]
    FILE.write_text(json.dumps(data))
    return True
`;

function home(t) {
  const dzHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-clean-')));
  t.after(() => fs.rmSync(dzHome, { recursive: true, force: true }));
  const scripts = path.join(dzHome, 'harness', 'skills', 'bug-fix', 'scripts');
  const batch = path.join(dzHome, 'workspaces', 'AAP1', 'batches', '7');
  const mirror = path.join(dzHome, 'workspaces', 'AAP1', 'mirror.git');
  for (const dir of [scripts, batch, mirror, path.join(dzHome, 'bug-fix-state')]) fs.mkdirSync(dir, { recursive: true });
  g(dzHome, 'init', '-q', '--bare', mirror);
  fs.writeFileSync(path.join(scripts, 'devices.py'), DEVICES);
  const file = path.join(dzHome, 'bug-fix-state', 'devices.json');
  const lock = holders => fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(holders).map(([s, holder]) => [s, { holder, since: 1 }]))));
  return { dzHome, batch, lock, scripts, left: () => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), project: { key: 'AAP1' } };
}

test('only the locks of the batch are released', async t => {
  const h = home(t);
  h.lock({ A: 'batch:7:J1', B: 'batch:77:J1', C: 'note:BUG-1', D: 'batch:7:J2', E: 'xbatch:7:J1' });
  assert.deepEqual(await releaseDevices({ dzHome: h.dzHome, batchId: 7 }), ['A', 'D']);
  assert.deepEqual(h.left(), ['B', 'C', 'E']);
  assert.equal(fs.existsSync(path.join(h.scripts, '__pycache__')), false);
});

test('no lock file means nothing to release', async t => {
  const h = home(t);
  assert.deepEqual(await releaseDevices({ dzHome: h.dzHome, batchId: 7 }), []);
});

test('a broken script is an error, not a silent success', async t => {
  const h = home(t);
  h.lock({ A: 'batch:7:J1' });
  fs.rmSync(path.join(h.scripts, 'devices.py'));
  await assert.rejects(releaseDevices({ dzHome: h.dzHome, batchId: 7 }), /python3/);
});

test('live processes inside the batch directory are stopped, others stay', async t => {
  const h = home(t);
  const inside = path.join(h.batch, 'repo');
  const outside = path.join(h.dzHome, 'workspaces', 'AAP1', 'batches', '77');
  for (const dir of [inside, outside]) fs.mkdirSync(dir);
  const run = cwd => spawn('/bin/sleep', ['60'], { cwd, stdio: 'ignore' });
  const victim = run(inside);
  const other = run(outside);
  t.after(() => [victim, other].forEach(child => child.kill('SIGKILL')));
  const gone = new Promise(resolve => victim.on('exit', (code, signal) => resolve(signal)));
  const stopped = await stopProcesses({ dzHome: h.dzHome, project: h.project, batchId: 7 });
  assert.deepEqual(stopped, [victim.pid]);
  assert.equal(await gone, 'SIGTERM');
  assert.equal(other.exitCode ?? other.signalCode, null);
});

test('a process that ignores SIGTERM is killed', async t => {
  const h = home(t);
  const child = spawn('/bin/sh', ['-c', 'trap "" TERM; echo ready; while :; do sleep 0.1; done'], { cwd: h.batch, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await new Promise(resolve => child.stdout.once('data', resolve));
  const gone = new Promise(resolve => child.on('exit', (code, signal) => resolve(signal)));
  await stopProcesses({ dzHome: h.dzHome, project: h.project, batchId: 7, graceMs: 300 });
  assert.equal(await gone, 'SIGKILL');
});

test('removing batch files keeps the rest of the workspace and does not follow symlinks', async t => {
  const h = home(t);
  const keep = path.join(h.dzHome, 'workspaces', 'AAP1', 'checkout');
  fs.mkdirSync(path.join(h.batch, 'repo-worktrees', 'x'), { recursive: true });
  fs.mkdirSync(path.join(h.batch, 'repo'));
  fs.mkdirSync(keep);
  fs.writeFileSync(path.join(keep, 'a'), 'a');
  fs.symlinkSync(keep, path.join(h.batch, 'link'));
  fs.writeFileSync(path.join(h.batch, 'start-sha'), 'x');
  await removeBatchFiles({ dzHome: h.dzHome, project: h.project, batchId: 7 });
  assert.deepEqual(fs.readdirSync(h.batch), ['start-sha']);
  assert.equal(fs.readFileSync(path.join(keep, 'a'), 'utf8'), 'a');
});

const STEP_DIR = `gate-${'a'.repeat(12)}`;

function evidence(h) {
  const dir = path.join(h.batch, STEP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of [['2-lint.log', 'lint đỏ'], ['result.json', '{}'], ['spec.json', '{}'], ['running.json', '{}']]) fs.writeFileSync(path.join(dir, name), text, { mode: 0o644 });
  fs.symlinkSync(path.join(h.dzHome, 'bug-fix-state'), path.join(dir, 'x.log'));
  fs.mkdirSync(path.join(h.batch, 'repo'), { recursive: true });
  fs.writeFileSync(path.join(h.batch, 'repo', 'a.log'), 'x');
  return path.join(h.dzHome, 'logs', 'batches', 'AAP1-7');
}

test('step logs and results are kept privately before the trees are removed, also when run again', async t => {
  const h = home(t);
  const kept = evidence(h);
  for (let i = 0; i < 2; i++) await removeBatchFiles({ dzHome: h.dzHome, project: h.project, batchId: 7 });
  assert.deepEqual(fs.readdirSync(kept), [STEP_DIR]);
  assert.deepEqual(fs.readdirSync(path.join(kept, STEP_DIR)).sort(), ['2-lint.log', 'result.json']);
  assert.equal(fs.readFileSync(path.join(kept, STEP_DIR, '2-lint.log'), 'utf8'), 'lint đỏ');
  assert.deepEqual(fs.readdirSync(h.batch), []);
  for (const dir of [kept, path.join(kept, STEP_DIR)]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(kept, STEP_DIR, '2-lint.log')).mode & 0o777, 0o600);
});

test('only abandoned batches older than 7 days are pruned, their evidence stays', async t => {
  const h = home(t);
  const db = memDb();
  const DAY = 24 * 3600 * 1000;
  const now = 100 * DAY;
  const add = (id, state, age) => db.prepare("INSERT INTO batches (id, project, version, kind, state, keys, opened_at, updated_at) VALUES (?, 'AAP1', '1', 'normal', ?, '[]', 1, ?)").run(id, state, now - age);
  add(7, 'abandoned', 8 * DAY);
  add(8, 'abandoned', 6 * DAY);
  add(9, 'running', 30 * DAY);
  add(10, 'abandoned', 30 * DAY);
  const kept = evidence(h);
  const repoOf = id => path.join(h.dzHome, 'workspaces', 'AAP1', 'batches', String(id), 'repo');
  for (const id of [8, 9]) fs.mkdirSync(repoOf(id), { recursive: true });
  const prune = at => pruneAbandoned({ db, dzHome: h.dzHome, project: h.project, now: at });
  assert.deepEqual(await prune(now), [7]);
  assert.equal(fs.existsSync(repoOf(7)), false);
  assert.ok(fs.existsSync(path.join(kept, STEP_DIR, '2-lint.log')));
  assert.equal(fs.existsSync(path.dirname(repoOf(10))), false);
  assert.ok(fs.existsSync(repoOf(8)) && fs.existsSync(repoOf(9)));
  assert.deepEqual(await prune(now + 2 * DAY), [8]);
});

test('a batch directory that is a symlink is refused', async t => {
  const h = home(t);
  const keep = path.join(h.dzHome, 'keep');
  fs.mkdirSync(path.join(keep, 'sub'), { recursive: true });
  fs.symlinkSync(keep, path.join(h.dzHome, 'workspaces', 'AAP1', 'batches', '8'));
  await assert.rejects(removeBatchFiles({ dzHome: h.dzHome, project: h.project, batchId: 8 }), { code: 'UNSAFE_PATH' });
  assert.equal(fs.existsSync(path.join(keep, 'sub')), true);
});

test('the real harness script releases the same way when it is available', { skip: !fs.existsSync(path.join(os.homedir(), '.dev-zone/spikes/harness/skills/bug-fix/scripts/devices.py')) }, async t => {
  const h = home(t);
  fs.copyFileSync(path.join(os.homedir(), '.dev-zone/spikes/harness/skills/bug-fix/scripts/devices.py'), path.join(h.scripts, 'devices.py'));
  const env = { ...process.env, BUG_FIX_STATE_DIR: path.join(h.dzHome, 'bug-fix-state') };
  const acquire = (serial, holder) => spawnSync('python3', ['-B', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import devices; devices.acquire(sys.argv[2], sys.argv[3])', h.scripts, serial, holder], { env });
  acquire('A', 'batch:7:J1');
  acquire('B', 'batch:8:J1');
  assert.deepEqual(await releaseDevices({ dzHome: h.dzHome, batchId: 7 }), ['A']);
  assert.deepEqual(h.left(), ['B']);
});
