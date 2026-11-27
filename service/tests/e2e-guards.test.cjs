const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { judgeAdb } = require('../src/e2e/adb-rules.cjs');
const { checkFlow } = require('../src/e2e/flow-rules.cjs');
const { judgeMaestro } = require('../src/e2e/maestro-rules.cjs');
const { startProxy } = require('../src/e2e/maestro-proxy.cjs');
const { writeShim } = require('../src/e2e/shim.cjs');
const { packageState, pick } = require('../src/devices.cjs');
const { readJournal } = require('../src/e2e/journal.cjs');
const { world } = require('./devices-fixtures.cjs');

const PKG = 'com.example.app';

function shimWorld(t) {
  const w = world(t);
  const root = path.join(w.dzHome, 'workspaces', 'AAP1', 'e2e', '1.9.2', 'app');
  fs.mkdirSync(path.join(root, '.maestro', 'ts'), { recursive: true });
  const sdk = path.join(w.dzHome, 'sdk');
  fs.mkdirSync(path.join(sdk, 'build-tools', '36.0.0'), { recursive: true });
  const harness = path.join(w.dzHome, 'android-test-harness');
  fs.mkdirSync(path.join(harness, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(harness, 'bin', 'replay.cjs'), "console.log(JSON.stringify(process.argv.slice(2)))");
  const apks = ['/x/new.apk', '/x/store.apk'];
  const shim = writeShim({ dzHome: w.dzHome, root, serial: 'AAA', pkg: PKG, apks, harness, adb: w.adb, env: { HOME: w.dzHome, PATH: '/usr/bin:/bin', ANDROID_HOME: sdk } });
  const run = (...args) => spawnSync(path.join(shim.sdk, 'platform-tools', 'adb'), args, { encoding: 'utf8' });
  const replay = (...args) => spawnSync(process.execPath, [shim.replay, shim.config, ...args], { encoding: 'utf8' });
  return { ...w, root, shim, run, replay, flow: (name, text) => fs.writeFileSync(path.join(root, '.maestro', 'ts', name), text) };
}

test('the E2E shim answers version and shows only its own device, so the harness init passes', t => {
  const s = shimWorld(t);
  assert.equal(s.run('version').status, 0);
  const out = s.run('devices');
  assert.equal(out.status, 0);
  assert.deepEqual(out.stdout.trim().split('\n'), ['List of devices attached', 'AAA\tdevice']);
  assert.ok(fs.existsSync(path.join(s.shim.sdk, 'build-tools', '36.0.0')));
  assert.equal(fs.statSync(path.join(s.shim.sdk, 'platform-tools', 'adb')).mode & 0o777, 0o700);
});

test('the E2E shim refuses other packages, other serials, reboot, push, pull and shell tricks, and never calls adb', t => {
  const s = shimWorld(t);
  const attempts = [
    ['-s', 'BBB', 'shell', 'pm', 'clear', PKG], ['shell', 'ls'], ['kill-server'], ['-s', 'AAA', 'reboot'], ['-s', 'AAA', 'root'],
    ['-s', 'AAA', 'shell', 'pm', 'clear', 'com.whatsapp'], ['-s', 'AAA', 'uninstall', 'com.whatsapp'], ['-s', 'AAA', 'uninstall', '-k', PKG],
    ['-s', 'AAA', 'push', '/etc/hosts', '/sdcard/x'], ['-s', 'AAA', 'pull', '/sdcard/DCIM', '.'], ['-s', 'AAA', 'install', '/y/other.apk'], ['-s', 'AAA', 'install', '--user', '0', '/x/new.apk'],
    ['-s', 'AAA', 'shell'], ['-s', 'AAA', 'shell', 'pm', 'path', PKG, ';', 'reboot'], ['-s', 'AAA', 'shell', `pm path ${PKG}; reboot`], ['-s', 'AAA', 'shell', 'rm', '-rf', '/sdcard'],
    ['-s', 'AAA', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'https://evil.example/?x=1'],
    ['-s', 'AAA', 'shell', 'am', 'start', '-n', `${PKG}/.Main`, '-d', 'https://evil.example/'], ['-s', 'AAA', 'shell', 'am', 'start', '-n', 'com.android.chrome/.Main'],
    ['-s', 'AAA', 'shell', 'am', 'start', '-n', `${PKG}/.Main`, 'com.android.chrome/.Main'], ['-s', 'AAA', 'shell', 'monkey', '-p', 'com.whatsapp', '1'], ['-s', 'AAA', 'shell', 'settings', 'put', 'global', 'x', '1'],
    ['-s', 'AAA', 'logcat', '-f', '/sdcard/x'], ['-s', 'AAA', 'exec-out', 'cat', '/sdcard/x'], ['-s', 'AAA', 'forward', 'tcp:1', 'tcp:1'],
  ];
  for (const args of attempts) assert.equal(s.run(...args).status, 2, args.join(' '));
  assert.deepEqual(s.calls(), []);
});

test('the E2E shim allows what the harness needs', () => {
  const config = { serial: 'AAA', package: PKG, apks: ['/x/new.apk'] };
  for (const args of [
    ['install', '-r', '-g', '/x/new.apk'], ['uninstall', PKG], ['shell', 'pm', 'path', PKG], ['shell', 'dumpsys', 'package', PKG], ['shell', 'getprop', 'ro.build.version.sdk'],
    ['shell', 'pm', 'grant', PKG, 'android.permission.CAMERA'], ['logcat', '-b', 'all', '-c'], ['logcat', '-b', 'system', '-d', '-s', 'ActivityManager:E'], ['get-state'], ['exec-out', 'screencap', '-p'],
    ['shell', 'am', 'start', '-n', `${PKG}/.Main`], ['shell', 'am', 'start', '-p', PKG, '-a', 'android.intent.action.VIEW', '-d', 'myapp://home'], ['shell', 'am', 'force-stop', PKG],
  ]) assert.equal(judgeAdb(['-s', 'AAA', ...args], config).ok, true, args.join(' '));
});

test('installs and uninstalls are journaled by the service outside the worker folder', t => {
  const s = shimWorld(t);
  s.run('-s', 'AAA', 'install', '/x/store.apk');
  s.run('-s', 'AAA', 'install', '-r', '/x/new.apk');
  s.run('-s', 'AAA', 'uninstall', PKG);
  assert.deepEqual(readJournal(s.root).map(({ verb, apk, update, ok }) => [verb, apk, update, ok]), [['install', '/x/store.apk', false, true], ['install', '/x/new.apk', true, true], ['uninstall', undefined, undefined, true]]);
});

const FLOW = text => () => checkFlow(text, { package: PKG, root: '/r', dir: '/r/.maestro/ts' });

test('flows that only drive the app are accepted', () => {
  FLOW(`appId: ${PKG}\nname: ts-1\n---\n- launchApp:\n    clearState: true\n- runFlow: ../subflows/preset-home.yaml\n- runFlow:\n    when:\n      true: \${MAESTRO_X == 'a'}\n    commands:\n      - tapOn: "Đăng nhập"\n- inputText: \${TESTER_EMAIL}\n- openLink: myapp://home\n- takeScreenshot: ".maestro/screenshots/ts/TC-1"\n`)();
});

test('flows that touch another app, the web, scripts or files outside are refused', () => {
  const body = [
    'appId: com.whatsapp\n---\n- launchApp', `appId: ${PKG}\n---\n- clearState: com.whatsapp`, `appId: ${PKG}\n---\n- launchApp:\n    appId: com.android.settings`, `appId: \${X}\n---\n- back`,
    `appId: ${PKG}\n---\n- openLink: https://evil.example/`, `appId: ${PKG}\n---\n- openLink:\n    link: https://evil.example/`, `appId: ${PKG}\n---\n- openLink: \${L}`, `appId: ${PKG}\n---\n- runScript: a.js`,
    `appId: ${PKG}\n---\n- evalScript: \${http.get('https://evil.example')}`, `appId: ${PKG}\n---\n- inputText: \${http.get('https://evil.example')}`, `appId: ${PKG}\n---\n- addMedia:\n    - /etc/hosts`,
    `appId: ${PKG}\n---\n- runFlow: ../../../../etc/x.yaml`, `appId: ${PKG}\n---\n- runFlow:\n    file: \${F}`, `appId: ${PKG}\n---\n- startRecording: x`, 'a: [', `appId: ${PKG}\n---\n- "runScript"`,
  ];
  for (const text of body) assert.throws(FLOW(text), undefined, text);
});

test('Maestro tools are held to the device, the app and flows inside .maestro', t => {
  const s = shimWorld(t);
  const config = JSON.parse(fs.readFileSync(s.shim.config, 'utf8'));
  const judge = (tool, args) => judgeMaestro(tool, args, config);
  for (const [tool, args] of [['list_devices', {}], ['inspect_screen', { device_id: 'AAA' }], ['run', { device_id: 'AAA', yaml: `appId: ${PKG}\n---\n- back` }], ['run', { device_id: 'AAA', files: [path.join(s.root, '.maestro', 'ts', 'a.yaml')] }]]) assert.equal(judge(tool, args), null, tool);
  for (const [tool, args] of [
    ['inspect_screen', {}], ['inspect_screen', { device_id: 'BBB' }], ['run', { device_id: 'AAA', deviceId: 'BBB', yaml: '' }], ['start_device', { platform: 'android' }], ['run_on_cloud', {}],
    ['launch_app', { device_id: 'AAA', appId: 'com.whatsapp' }], ['run', { device_id: 'AAA', yaml: 'appId: com.whatsapp\n---\n- clearState' }], ['run', { device_id: 'AAA', files: ['/etc/a.yaml'] }], ['run', { device_id: 'AAA', files: '../a.yaml' }],
  ]) assert.notEqual(judge(tool, args), null, JSON.stringify(args));
  s.flow('bad.yaml', 'appId: com.whatsapp\n---\n- clearState\n');
  assert.match(judge('run', { device_id: 'AAA', yaml: `appId: ${PKG}\n---\n- back` }), /bad\.yaml/);
});

test('the Maestro proxy forwards good calls, answers bad ones itself, and reconnects after Maestro dies', async () => {
  const children = [];
  const launch = () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => {}, seen: [] });
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', chunk => chunk.trim().split('\n').forEach(line => {
      const message = JSON.parse(line);
      child.seen.push(message.method);
      if (message.id !== undefined && message.params?.name !== 'inspect_screen') child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { from: children.length } })}\n`);
    }));
    children.push(child);
    return child;
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const got = [];
  output.on('data', chunk => String(chunk).trim().split('\n').forEach(line => got.push(JSON.parse(line))));
  startProxy({ serial: 'AAA', package: PKG, root: '/none', maestro: 'maestro' }, { input, output, launch });
  const send = async message => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  const call = (id, name, args) => send({ id, method: 'tools/call', params: { name, arguments: args } });
  await send({ id: 1, method: 'initialize', params: {} });
  await send({ method: 'notifications/initialized' });
  await call(2, 'launch_app', { device_id: 'AAA', appId: 'com.whatsapp' });
  assert.equal(got.find(m => m.id === 2).result.isError, true);
  assert.deepEqual(children[0].seen, ['initialize', 'notifications/initialized']);
  await call(3, 'inspect_screen', { device_id: 'AAA' });
  children[0].emit('exit');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(got.find(m => m.id === 3).result.isError, true);
  await call(4, 'list_devices', {});
  assert.deepEqual(children[1].seen, ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(got.find(m => m.id === 4).result.from, 2);
  assert.equal(got.filter(m => m.id === 1).length, 1);
});

test('replay runs the harness with the fixed root and serial only after its flows are checked', t => {
  const s = shimWorld(t);
  s.flow('a.yaml', `appId: ${PKG}\n---\n- back\n`);
  assert.deepEqual(JSON.parse(s.replay('--root', '/evil', '--serial', 'BBB', '--round', '2').stdout), ['--root', s.root, '--serial', 'AAA', '--round', '2']);
  assert.equal(s.replay('--round', '2', '--maestro', '/evil').status, 2);
  s.flow('b.yaml', `appId: ${PKG}\n---\n- evalScript: \${1}\n`);
  assert.equal(s.replay('--round', '2').status, 2);
});

test('packageState reads presence and lastUpdateTime of exactly the package', async t => {
  const none = world(t, { adbOutput: 'package:com.example.app.dev\n' });
  assert.deepEqual(await packageState({ serial: 'AAA', pkg: PKG, adb: none.adb }), { present: false, lastUpdate: null });
  const some = world(t, { adbOutput: `package:${PKG}\n    lastUpdateTime=2026-11-25 10:00:00\n` });
  assert.deepEqual(await packageState({ serial: 'AAA', pkg: PKG, adb: some.adb }), { present: true, lastUpdate: '2026-11-25 10:00:00' });
});

test('pick honours the allow-list and the skip list', async t => {
  const w = world(t);
  const args = { dzHome: w.dzHome, project: w.project, adb: w.adb };
  assert.equal(await pick({ ...args, only: ['DDD'] }), 'DDD');
  assert.equal(await pick({ ...args, only: ['DDD'], skip: ['DDD'] }), null);
  assert.equal(await pick({ ...args, only: [] }), null);
});
