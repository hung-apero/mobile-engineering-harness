const fs = require('node:fs');
const path = require('node:path');
const { processStart, isSameProcess, stopWorker } = require('./worker.cjs');

const STOP_GRACE_MS = 10000;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
const fileOf = dir => path.join(dir, 'running.json');

function writeNew(file, text) {
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function recordRunning(dir, pid) {
  let start = null;
  try {
    start = processStart(pid);
  } catch {}
  if (!start) return;
  const temp = `${fileOf(dir)}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  writeNew(temp, JSON.stringify({ pid, start }));
  fs.renameSync(temp, fileOf(dir));
}

const clearRunning = dir => fs.rmSync(fileOf(dir), { force: true });

function readRunning(dir) {
  try {
    const fd = fs.openSync(fileOf(dir), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const { pid, start } = JSON.parse(fs.readFileSync(fd, 'utf8')) ?? {};
      return Number.isSafeInteger(pid) && pid > 1 && typeof start === 'string' ? { pid, start } : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

async function stopLeftover(dir) {
  const left = readRunning(dir);
  if (left && isSameProcess(left.pid, left.start) && !(await stopWorker(left.pid, left.start, STOP_GRACE_MS))) {
    throw new Error(`bước của lần chạy trước (pid ${left.pid}) chưa dừng`);
  }
  clearRunning(dir);
}

function markStarted(file) {
  try {
    writeNew(file, '');
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

module.exports = { recordRunning, clearRunning, stopLeftover, markStarted };
