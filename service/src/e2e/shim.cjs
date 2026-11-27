const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findAdb, ADB_PATH, SERIAL, PACKAGE } = require('../devices.cjs');
const { journalFile } = require('./journal.cjs');

const quote = text => `'${text.replaceAll("'", `'\\''`)}'`;

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(dir) !== dir) throw new Error(`${dir} phải là thư mục thật`);
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writeFile(file, text, mode) {
  fs.rmSync(file, { force: true, recursive: true });
  fs.writeFileSync(file, text, { mode, flag: 'wx' });
  return file;
}

function realSdk(env) {
  const dir = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || path.join(env.HOME || os.homedir(), 'Library', 'Android', 'sdk');
  return fs.existsSync(dir) ? dir : null;
}

function realMaestro(env) {
  const own = path.join(env.HOME || os.homedir(), '.maestro', 'bin', 'maestro');
  return fs.existsSync(own) ? own : 'maestro';
}

function realAdb({ dzHome, adb, sdk }) {
  const inSdk = sdk && path.join(sdk, 'platform-tools', 'adb');
  const found = adb ?? (inSdk && fs.existsSync(inSdk) ? inSdk : findAdb(dzHome));
  if (!ADB_PATH.test(found)) throw new Error('adb không hợp lệ');
  return found;
}

function linkBuildTools(sdk, dir) {
  const link = path.join(dir, 'build-tools');
  fs.rmSync(link, { force: true });
  const target = sdk && path.join(sdk, 'build-tools');
  if (target && fs.existsSync(target)) fs.symlinkSync(target, link);
}

function writeShim({ dzHome, root, serial, pkg, apks, harness, adb, env = process.env }) {
  if (!SERIAL.test(serial) || !PACKAGE.test(pkg)) throw new Error('serial hoặc package không hợp lệ');
  const home = privateDir(path.join(path.dirname(root), 'guard'));
  const sdkDir = privateDir(path.join(home, 'sdk'));
  const bin = privateDir(path.join(sdkDir, 'platform-tools'));
  const sdk = realSdk(env);
  linkBuildTools(sdk, sdkDir);
  const config = {
    serial, package: pkg, apks, root, harness, adb: realAdb({ dzHome, adb, sdk }), maestro: realMaestro(env), journal: journalFile(root),
    env: { PATH: env.PATH ?? '', ...(sdk && { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }) },
  };
  const file = writeFile(path.join(home, 'guard.json'), `${JSON.stringify(config)}\n`, 0o600);
  writeFile(path.join(bin, 'adb'), `#!/bin/sh\nexec ${[process.execPath, path.join(__dirname, 'adb-guard.cjs'), file].map(quote).join(' ')} "$@"\n`, 0o700);
  return { config: file, bin, sdk: sdkDir, adb: path.join(bin, 'adb'), replay: path.join(__dirname, 'replay-guard.cjs'), proxy: path.join(__dirname, 'maestro-proxy.cjs') };
}

module.exports = { writeShim };
