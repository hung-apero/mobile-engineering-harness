const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HOLDER = /^spec:[A-Za-z0-9-]+:[A-Za-z0-9._-]+$/;
const PREFIX = /^spec:[A-Za-z0-9-]+:$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const ADB_PATH = /^[A-Za-z0-9_./+-]+$/;
const KINDS = {
  any: () => true,
  emulator: serial => serial.startsWith('emulator-'),
  physical: serial => !serial.startsWith('emulator-'),
};
const BLOCKED = 'devices kill-server start-server connect disconnect pair reconnect usb tcpip mdns';
const PRELUDE = 'import json, sys\nsys.path.insert(0, sys.argv[1])\nimport devices\n';
const ACQUIRE = 'ok, holder, secs = devices.acquire(sys.argv[2], sys.argv[3])\nprint(json.dumps([ok, holder, secs]))';
const RELEASE = 'print(json.dumps(devices.release(sys.argv[2], sys.argv[3])))';
const SNAPSHOT = 'print(json.dumps(devices.snapshot()))';
const RELEASE_ALL = [
  'freed = []',
  'for serial, entry in devices.snapshot().items():',
  '    if entry["holder"].startswith(sys.argv[2]) and devices.release(serial, entry["holder"]): freed.append(serial)',
  'print(json.dumps(sorted(freed)))',
].join('\n');

function exec(bin, args, env) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(new Error(`${path.basename(bin)}: ${error.message.split('\n')[0]}`));
      resolve(stdout);
    });
  });
}

function check(pattern, value, name) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} không hợp lệ`);
  return value;
}

async function python(dzHome, body, args = []) {
  const scripts = path.join(dzHome, 'harness', 'skills', 'bug-fix', 'scripts');
  if (!fs.lstatSync(path.join(scripts, 'devices.py'), { throwIfNoEntry: false })?.isFile()) throw new Error('không có devices.py của bug-fix');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, BUG_FIX_STATE_DIR: path.join(dzHome, 'bug-fix-state') };
  return JSON.parse(await exec('python3', ['-I', '-B', '-c', PRELUDE + body, scripts, ...args], env));
}

async function listDevices({ adb = 'adb' } = {}) {
  const out = await exec(adb, ['devices'], { PATH: process.env.PATH, HOME: process.env.HOME });
  return out.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(([serial, state]) => serial && state === 'device' && SERIAL.test(serial)).map(([serial]) => serial);
}

async function pick({ dzHome, project, kind = 'any', adb, only = null, skip = [] }) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('kind không hợp lệ');
  const [online, taken] = await Promise.all([listDevices({ adb }), python(dzHome, SNAPSHOT)]);
  const excluded = new Set(project.excludedDevices ?? []);
  return online.find(serial => !excluded.has(serial) && !taken[serial] && KINDS[kind](serial) && (only === null || only.includes(serial)) && !skip.includes(serial)) ?? null;
}

async function packageState({ serial, pkg, adb = 'adb' }) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const shell = args => exec(adb, ['-s', check(SERIAL, serial, 'serial'), 'shell', ...args], env);
  const listed = await shell(['pm', 'list', 'packages', check(PACKAGE, pkg, 'package')]);
  if (!listed.split(/\r?\n/).includes(`package:${pkg}`)) return { present: false, lastUpdate: null };
  const info = await shell(['dumpsys', 'package', pkg]);
  return { present: true, lastUpdate: info.match(/lastUpdateTime=([^\r\n]+)/)?.[1].trim() ?? null };
}

async function acquire({ dzHome, holder, serial }) {
  check(HOLDER, holder, 'holder');
  check(SERIAL, serial, 'serial');
  const [ok] = await python(dzHome, ACQUIRE, [serial, holder]);
  return ok ? { serial, holder } : null;
}

async function release({ dzHome, holder, serial }) {
  check(HOLDER, holder, 'holder');
  check(SERIAL, serial, 'serial');
  return python(dzHome, RELEASE, [serial, holder]);
}

async function releaseAll({ dzHome, prefix }) {
  return python(dzHome, RELEASE_ALL, [check(PREFIX, prefix, 'prefix')]);
}

function findAdb(dzHome) {
  const own = path.join(dzHome, 'adb-wrappers') + path.sep;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, 'adb');
    if (path.isAbsolute(dir) && !dir.startsWith(own) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
  }
  throw new Error('không tìm thấy adb');
}

function writeAdbWrapper({ dzHome, serial, adb = 'adb' }) {
  check(SERIAL, serial, 'serial');
  const real = check(ADB_PATH, adb === 'adb' ? findAdb(dzHome) : adb, 'adb');
  const dir = path.join(dzHome, 'adb-wrappers', serial.replace(/[^A-Za-z0-9._-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const script = [
    '#!/bin/sh',
    `if [ "$1" != "-s" ] || [ "$2" != "${serial}" ]; then echo "adb: chỉ được dùng -s ${serial}" >&2; exit 2; fi`,
    'case "$3" in',
    `  ""|-*|${BLOCKED.split(' ').join('|')}) echo "adb: lệnh không được phép" >&2; exit 2;;`,
    'esac',
    `exec ${real} "$@"`,
    '',
  ].join('\n');
  const file = path.join(dir, 'adb');
  fs.writeFileSync(file, script, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return dir;
}

module.exports = { listDevices, pick, packageState, acquire, release, releaseAll, findAdb, writeAdbWrapper, SERIAL, PACKAGE, ADB_PATH };
