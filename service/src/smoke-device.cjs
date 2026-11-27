const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SERIAL, PACKAGE } = require('./devices.cjs');

const ADB_TIMEOUT_MS = 3 * 60 * 1000;
const LAUNCHER = 'android.intent.category.LAUNCHER';

class SmokeError extends Error {}

function newestApk(apkGlob) {
  if (typeof apkGlob !== 'string' || !apkGlob || path.isAbsolute(apkGlob) || apkGlob.split(/[\\/]/).includes('..')) throw new SmokeError('apkGlob phải là đường dẫn tương đối trong cây code');
  const root = fs.realpathSync('.');
  const found = fs.globSync(apkGlob, { cwd: root }).map(name => path.resolve(root, name))
    .filter(file => file.startsWith(root + path.sep) && fs.lstatSync(file).isFile() && fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!found.length) throw new SmokeError(`không thấy APK theo ${apkGlob}`);
  return found[0];
}

function adbOf(serial) {
  return (...args) => {
    try {
      return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: ADB_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      throw Object.assign(new SmokeError(String(error.stderr || error.message).trim().split('\n')[0]), { status: error.status });
    }
  };
}

const quiet = fn => {
  try {
    return fn();
  } catch {
    return '';
  }
};

function crashOf(log, pkg) {
  if (!log.includes(pkg)) return null;
  const lines = log.split('\n').map(line => line.trim());
  return lines.find(line => /Exception|Error:/.test(line)) ?? lines.find(line => line.includes('FATAL')) ?? 'không rõ lỗi';
}

function smoke([apkGlob, pkg, serial], wait) {
  if (!PACKAGE.test(pkg ?? '')) throw new SmokeError('package không hợp lệ');
  if (!SERIAL.test(serial ?? '')) throw new SmokeError('serial không hợp lệ');
  const apk = newestApk(apkGlob);
  const adb = adbOf(serial);
  try {
    adb('install', '-r', '-t', apk);
  } catch (error) {
    throw new SmokeError(`không cài được ${path.basename(apk)}: ${error.message}`);
  }
  quiet(() => adb('logcat', '-c', '-b', 'crash'));
  adb('shell', 'am', 'force-stop', pkg);
  adb('shell', 'monkey', '-p', pkg, '-c', LAUNCHER, '1');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  const crash = crashOf(quiet(() => adb('logcat', '-d', '-b', 'crash')), pkg);
  if (crash) throw new SmokeError(`app crash khi mở: ${crash}`);
  if (!quiet(() => adb('shell', 'pidof', pkg)).trim()) throw new SmokeError('app không còn chạy sau khi mở');
  return apk;
}

try {
  const apk = smoke(process.argv.slice(2), Number(process.env.DZ_SMOKE_WAIT_MS ?? 8000));
  process.stdout.write(`đã cài và mở ${path.basename(apk)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof SmokeError ? error.message : String(error)}\n`.slice(0, 1000));
  process.exitCode = 1;
}
