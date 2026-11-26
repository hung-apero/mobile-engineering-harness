const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeScript } = require('./service-fixtures.cjs');

const SCRIPT = path.join(__dirname, '..', 'src', 'smoke-device.cjs');
const PKG = 'com.demo.app';
const ADB = `#!/bin/sh
echo "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  *"shell pidof"*) if [ -n "$FAKE_PID" ]; then echo "$FAKE_PID"; else exit 1; fi;;
  *"logcat -d -b crash"*) printf '%s' "$FAKE_CRASH";;
  *"install"*) [ -z "$FAKE_INSTALL_FAIL" ] || { echo "INSTALL_FAILED_VERSION_DOWNGRADE" >&2; exit 1; };;
esac
exit 0
`;

function world(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-smoke-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const tree = path.join(root, 'tree');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(tree, 'out'), { recursive: true });
  writeScript(path.join(bin, 'adb'), ADB.replace('#!/bin/sh\n', ''));
  const apk = (name, at) => {
    const file = path.join(tree, 'out', name);
    fs.writeFileSync(file, name);
    fs.utimesSync(file, at, at);
    return file;
  };
  const log = path.join(root, 'adb.log');
  const run = (env = {}, args = ['out/*.apk', PKG, 'emu-1']) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: tree, encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, FAKE_ADB_LOG: log, FAKE_PID: '4242', FAKE_CRASH: '', DZ_SMOKE_WAIT_MS: '0', ...env },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { tree, apk, run, calls };
}

test('smoke-device installs the newest apk and opens the package on the given serial', t => {
  const w = world(t);
  w.apk('old.apk', 1000);
  const fresh = w.apk('new.apk', 2000);
  const out = w.run();
  assert.equal(out.status, 0, out.stderr);
  const calls = w.calls();
  assert.ok(calls.every(line => line.startsWith('-s emu-1 ')), calls.join('\n'));
  assert.ok(calls.includes(`-s emu-1 install -r -t ${fresh}`));
  assert.ok(calls.includes(`-s emu-1 shell monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`));
  assert.ok(calls.indexOf(`-s emu-1 install -r -t ${fresh}`) < calls.findIndex(line => line.includes('monkey')));
  assert.ok(calls.some(line => line === `-s emu-1 shell pidof ${PKG}`));
});

test('smoke-device fails when the app is not running or crashed', t => {
  const w = world(t);
  w.apk('a.apk', 1000);
  const dead = w.run({ FAKE_PID: '' });
  assert.equal(dead.status, 1);
  assert.match(dead.stderr, /không còn chạy/);
  const crashed = w.run({ FAKE_CRASH: `FATAL EXCEPTION: main\nProcess: ${PKG}, PID: 4242\njava.lang.IllegalStateException: boom\n` });
  assert.equal(crashed.status, 1);
  assert.match(crashed.stderr, /crash/);
  assert.match(crashed.stderr, /IllegalStateException|FATAL/);
  const refused = w.run({ FAKE_INSTALL_FAIL: '1' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cài/);
});

test('smoke-device refuses a missing apk and bad arguments before touching the device', t => {
  const w = world(t);
  const none = w.run();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /APK/);
  w.apk('a.apk', 1000);
  for (const args of [['out/*.apk', 'not a package', 'emu-1'], ['out/*.apk', PKG, '-s x'], ['../*.apk', PKG, 'emu-1']]) {
    assert.equal(w.run({}, args).status, 1);
  }
  assert.deepEqual(w.calls(), []);
});
