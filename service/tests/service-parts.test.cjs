const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openDb } = require('../src/db.cjs');
const { createServiceLog } = require('../src/service-log.cjs');
const { acquireLock, releaseLock, lockOwner, ownsLock } = require('../src/service-lock.cjs');
const { processStart } = require('../src/worker.cjs');
const { redact } = require('../src/redact.cjs');
const { resolvePaths, createContext } = require('../src/context.cjs');


function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-part-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the log is one JSON line per event, mode 600, rotated to .1, without secrets', t => {
  const file = path.join(temp(t), 'service.jsonl');
  const log = createServiceLog(file, { maxBytes: 150 });
  log('a', { error: 'https://discord.com/api/webhooks/1/abc sk-ant-xyz Bearer abc a@b.co ATATT3xFf-_=1' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const line = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(line.event, 'a');
  assert.equal(line.error, '[ẩn] [ẩn] [ẩn] [ẩn] [ẩn]');
  log('b', { pad: 'x'.repeat(200) });
  log('c');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.1`, 'utf8').trim().split('\n').at(-1)).event, 'b');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).event, 'c');
});

test('a log that cannot be written does not throw', t => {
  createServiceLog(path.join(temp(t), 'gone', 'x.jsonl'))('a');
});

test('lock: held by a live process, taken over when stale or garbage, released only by its owner', t => {
  const dir = temp(t);
  const db = openDb(path.join(dir, 'dz.db'));
  const file = path.join(dir, 'service.lock');
  assert.deepEqual(acquireLock(db, file), { ok: true });
  assert.deepEqual(lockOwner(file), { pid: process.pid, pidStart: processStart(process.pid) });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(ownsLock(file), true);
  assert.deepEqual(acquireLock(db, file), { ok: false, pid: process.pid });
  const other = { pid: process.ppid, pidStart: processStart(process.ppid) };
  fs.writeFileSync(file, JSON.stringify(other));
  releaseLock(db, file);
  assert.deepEqual(lockOwner(file), other);
  for (const stale of [JSON.stringify({ ...other, pidStart: 'Mon Jan  1 00:00:00 2001' }), '', 'x', '[]']) {
    fs.writeFileSync(file, stale);
    assert.deepEqual(acquireLock(db, file), { ok: true });
  }
  releaseLock(db, file);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.includes('lock')), []);
});

test('lock: several processes taking over the same stale lock at once give exactly one owner', async t => {
  const dir = temp(t);
  const file = path.join(dir, 'service.lock');
  openDb(path.join(dir, 'dz.db')).close();
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, pidStart: 'Mon Jan  1 00:00:00 2001' }));
  const src = name => JSON.stringify(path.join(__dirname, '..', 'src', name));
  const code = `
    const { openDb } = require(${src('db.cjs')});
    const { acquireLock } = require(${src('service-lock.cjs')});
    const db = openDb(${JSON.stringify(path.join(dir, 'dz.db'))});
    while (Date.now() < ${Date.now() + 1500}) {}
    console.log(JSON.stringify(acquireLock(db, ${JSON.stringify(file)})));
    setTimeout(() => {}, 4000);`;
  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', () => resolve({ pid: child.pid, ...JSON.parse(out), owner: JSON.parse(out).pid ?? child.pid }));
  });
  const results = await Promise.all([run(), run(), run(), run(), run()]);
  const winners = results.filter(r => r.ok);
  assert.equal(winners.length, 1);
  assert.ok(results.every(r => r.owner === winners[0].owner));
});

test('home: created with mode 700 and every folder, home, secrets and logs put back to 700 at startup; paths come from DZ_HOME and DZ_RULES_DIR', t => {
  const dir = temp(t);
  const env = { DZ_HOME: path.join(dir, 'home') };
  createContext(env).db.close();
  for (const name of ['.', 'secrets', 'logs']) fs.chmodSync(path.join(env.DZ_HOME, name), 0o755);
  createContext(env).db.close();
  for (const name of ['.', 'logs', 'secrets', 'projects', 'workspaces', 'probe', 'bug-fix-state']) {
    assert.equal(fs.statSync(path.join(env.DZ_HOME, name)).mode & 0o777, 0o700);
  }
  assert.equal(resolvePaths(env).rulesDir, path.join(__dirname, '..', 'rules'));
  assert.equal(resolvePaths({ ...env, DZ_RULES_DIR: '/r' }).rulesDir, '/r');
  assert.equal(resolvePaths({}).dzHome, path.join(os.homedir(), '.dev-zone'));
});

test('redact keeps ordinary text', () => {
  assert.equal(redact('việc #1 (ABC1): lỗi 3 lần'), 'việc #1 (ABC1): lỗi 3 lần');
});
