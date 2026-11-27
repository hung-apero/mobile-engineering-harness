const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const devices = require('../src/devices.cjs');
const { world } = require('./devices-fixtures.cjs');

test('listDevices keeps only serials in state device and runs only adb devices', async t => {
  const w = world(t);
  assert.deepEqual(await devices.listDevices({ adb: w.adb }), ['AAA', 'emulator-5554', 'DDD']);
  assert.deepEqual(w.calls(), ['devices']);
});

test('pick skips excluded devices and devices held by anyone', async t => {
  const w = world(t);
  w.lock('AAA', 'note:AAP864-1');
  const project = { ...w.project, excludedDevices: ['emulator-5554'] };
  assert.equal(await devices.pick({ dzHome: w.dzHome, project, adb: w.adb }), 'DDD');
});

test('pick honours the kind and returns null when nothing qualifies', async t => {
  const w = world(t);
  assert.equal(await devices.pick({ dzHome: w.dzHome, project: w.project, kind: 'emulator', adb: w.adb }), 'emulator-5554');
  assert.equal(await devices.pick({ dzHome: w.dzHome, project: w.project, kind: 'physical', adb: w.adb }), 'AAA');
  const none = { ...w.project, excludedDevices: ['AAA', 'DDD', 'emulator-5554'] };
  assert.equal(await devices.pick({ dzHome: w.dzHome, project: none, adb: w.adb }), null);
  await assert.rejects(devices.pick({ dzHome: w.dzHome, project: w.project, kind: 'tablet', adb: w.adb }));
});

test('acquire writes the lock under BUG_FIX_STATE_DIR in dz home and is idempotent for the same holder', async t => {
  const w = world(t);
  const holder = 'spec:s1:smoke';
  assert.deepEqual(await devices.acquire({ dzHome: w.dzHome, holder, serial: 'AAA' }), { serial: 'AAA', holder });
  assert.deepEqual(await devices.acquire({ dzHome: w.dzHome, holder, serial: 'AAA' }), { serial: 'AAA', holder });
  assert.equal(w.held().AAA.holder, holder);
  assert.ok(fs.existsSync(path.join(w.dzHome, 'bug-fix-state', 'devices.json')));
});

test('acquire of a busy device returns null and keeps the other holder', async t => {
  const w = world(t);
  w.lock('AAA', 'note:AAP864-1');
  assert.equal(await devices.acquire({ dzHome: w.dzHome, holder: 'spec:s1:smoke', serial: 'AAA' }), null);
  assert.equal(w.held().AAA.holder, 'note:AAP864-1');
});

test('release frees only the lock of its own holder', async t => {
  const w = world(t);
  w.lock('AAA', 'batch:7:JOB');
  assert.equal(await devices.release({ dzHome: w.dzHome, holder: 'spec:s1:smoke', serial: 'AAA' }), false);
  assert.equal(w.held().AAA.holder, 'batch:7:JOB');
  await devices.acquire({ dzHome: w.dzHome, holder: 'spec:s1:smoke', serial: 'DDD' });
  assert.equal(await devices.release({ dzHome: w.dzHome, holder: 'spec:s1:smoke', serial: 'DDD' }), true);
  assert.equal(w.held().DDD, undefined);
});

test('releaseAll frees every lock of one spec prefix and nobody else', async t => {
  const w = world(t);
  w.lock('AAA', 'spec:s1:smoke');
  w.lock('DDD', 'spec:s1:uidiff-2');
  w.lock('emulator-5554', 'spec:s12:smoke');
  w.lock('XXX', 'note:AAP864-1');
  w.lock('YYY', 'batch:s1:JOB');
  assert.deepEqual(await devices.releaseAll({ dzHome: w.dzHome, prefix: 'spec:s1:' }), ['AAA', 'DDD']);
  assert.deepEqual(Object.keys(w.held()).sort(), ['XXX', 'YYY', 'emulator-5554']);
});

test('releaseAll refuses prefixes that could reach holders of other kinds', async t => {
  const w = world(t);
  for (const prefix of ['note:', 'batch:7:', 'spec:', 'spec:s1', '', 'spec:s1:;x', undefined]) {
    await assert.rejects(devices.releaseAll({ dzHome: w.dzHome, prefix }), /prefix/);
  }
});

test('holders and serials are validated before any process runs', async t => {
  const w = world(t);
  for (const holder of ['note:X-1', 'spec:s1', 'spec:s1:a b', '', 5]) await assert.rejects(devices.acquire({ dzHome: w.dzHome, holder, serial: 'AAA' }), /holder/);
  for (const serial of ['', '-s', 'a b', 'a;b', '$(x)', 'a'.repeat(65)]) await assert.rejects(devices.acquire({ dzHome: w.dzHome, holder: 'spec:s1:smoke', serial }), /serial/);
  assert.deepEqual(w.held(), {});
});

test('a missing devices.py is an error, not a silent free device', async t => {
  const w = world(t);
  fs.rmSync(path.join(w.dzHome, 'harness', 'skills', 'bug-fix', 'scripts', 'devices.py'));
  await assert.rejects(devices.acquire({ dzHome: w.dzHome, holder: 'spec:s1:smoke', serial: 'AAA' }), /devices\.py/);
});

function wrapper(t, serial = 'AAA') {
  const w = world(t);
  const dir = devices.writeAdbWrapper({ dzHome: w.dzHome, serial, adb: w.adb });
  const run = (...args) => spawnSync(path.join(dir, 'adb'), args, { encoding: 'utf8' });
  return { ...w, dir, run };
}

test('the adb wrapper dir and script are mode 700', t => {
  const { dir } = wrapper(t);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'adb')).mode & 0o777, 0o700);
});

test('the adb wrapper forwards commands for its serial and nothing else', t => {
  const { run, calls } = wrapper(t);
  assert.equal(run('-s', 'AAA', 'shell', 'am', 'start', '-a', 'x').status, 0);
  assert.equal(run('-s', 'AAA', 'install', '-r', 'a.apk').status, 0);
  assert.deepEqual(calls(), ['-s AAA shell am start -a x', '-s AAA install -r a.apk']);
});

test('the adb wrapper rejects other serials, bare commands, global flags and server commands', t => {
  const { run, calls } = wrapper(t);
  const attempts = [
    [], ['devices'], ['shell', 'ls'], ['-s', 'BBB', 'shell'], ['-s', 'AAA'], ['-s', 'AAA', '-s', 'BBB', 'shell'],
    ['-s', 'AAA', '-d', 'shell'], ['-s', 'AAA', 'devices'], ['-s', 'AAA', 'kill-server'], ['-s', 'AAA', 'connect', 'x:1'],
    ['-e', 'shell'], ['-s', 'AAAx', 'shell'],
  ];
  for (const args of attempts) assert.equal(run(...args).status, 2, args.join(' '));
  assert.deepEqual(calls(), []);
});

test('the wrapper resolves adb from PATH but never to itself', t => {
  const w = world(t);
  const env = process.env.PATH;
  t.after(() => { process.env.PATH = env; });
  process.env.PATH = `${w.bin}${path.delimiter}${env}`;
  const first = devices.writeAdbWrapper({ dzHome: w.dzHome, serial: 'AAA' });
  process.env.PATH = `${first}${path.delimiter}${process.env.PATH}`;
  const second = devices.writeAdbWrapper({ dzHome: w.dzHome, serial: 'AAA' });
  assert.match(fs.readFileSync(path.join(second, 'adb'), 'utf8'), new RegExp(`exec ${w.adb} `));
  assert.ok(execFileSync(path.join(second, 'adb'), ['-s', 'AAA', 'get-state'], { encoding: 'utf8' }).startsWith('List of devices'));
});

test('unsafe serials and adb paths never reach the wrapper script', t => {
  const w = world(t);
  assert.throws(() => devices.writeAdbWrapper({ dzHome: w.dzHome, serial: 'A";rm -rf ~;"', adb: w.adb }), /serial/);
  assert.throws(() => devices.writeAdbWrapper({ dzHome: w.dzHome, serial: 'AAA', adb: '/x y/adb' }), /adb/);
  assert.throws(() => devices.writeAdbWrapper({ dzHome: w.dzHome, serial: 'AAA', adb: '/x;y/adb' }), /adb/);
});
