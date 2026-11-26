const fs = require('fs');
const os = require('os');
const path = require('path');

const STALE_MS = 10000;
// A holder older than this is taken over even if its pid looks alive (Windows reuses pids; Gradle gives up at 40 min).
const MAX_HOLD_MS = 90 * 60 * 1000;

function lockDir() {
  const dir = process.env.LEARN_APP_LOCK_DIR || path.join(os.tmpdir(), 'learn-app-locks');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultSlots(name) {
  if (name !== 'build') return 1;
  if (process.env.LEARN_APP_PARALLEL === '1') return 1;
  if (process.env.LEARN_APP_BUILD_SLOTS) return Number(process.env.LEARN_APP_BUILD_SLOTS);
  return os.totalmem() >= 16 * 1024 ** 3 ? 2 : 1;
}

function isDeadPid(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function readLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Holder is gone (pid dead) or the file is unreadable/garbage and old enough to not be mid-write.
function staleHolder(file) {
  const info = readLock(file);
  if (info && typeof info.pid === 'number') return isDeadPid(info.pid) || Date.now() - Number(info.at || 0) > MAX_HOLD_MS;
  try {
    return Date.now() - fs.statSync(file).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

function slotFile(name, k) {
  return path.join(lockDir(), `${name}-${k}.lock`);
}

function acquireSlot(file, label) {
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), label }), { flag: 'wx' });
  return () => {
    const info = readLock(file);
    if (info && info.pid === process.pid) fs.rmSync(file, { force: true });
  };
}

function tryAcquire(name, slots, label = '') {
  for (let k = 0; k < slots; k += 1) {
    const file = slotFile(name, k);
    try {
      return acquireSlot(file, label);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!staleHolder(file)) continue;
      // Rename first: of two waiters that both saw the stale holder, only one wins the rename, so the other
      // can never delete the fresh lock the winner just took.
      const claimed = `${file}.${process.pid}.${Date.now()}.stale`;
      try {
        fs.renameSync(file, claimed);
      } catch {
        continue;
      }
      if (!staleHolder(claimed)) {
        try {
          fs.renameSync(claimed, file);
        } catch {}
        continue;
      }
      fs.rmSync(claimed, { force: true });
      try {
        return acquireSlot(file, label);
      } catch (retryError) {
        if (retryError.code !== 'EEXIST') throw retryError;
      }
    }
  }
  return null;
}

function holders(name, slots) {
  const list = [];
  for (let k = 0; k < slots; k += 1) {
    const info = readLock(slotFile(name, k));
    if (info) list.push(info.label || `pid ${info.pid}`);
  }
  return list;
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Blocks until a slot is free and returns its release function.
function waitForSlot(name, options = {}) {
  const { slots = defaultSlots(name), label = '', pollMs = 2000, timeoutMs = 60 * 60 * 1000, onWait } = options;
  const deadline = Date.now() + timeoutMs;
  let release = tryAcquire(name, slots, label);
  let announced = false;
  while (!release) {
    if (!announced && onWait) {
      onWait(holders(name, slots));
      announced = true;
    }
    if (Date.now() > deadline) throw new Error(`Chờ khe ${name} quá lâu`);
    pause(pollMs);
    release = tryAcquire(name, slots, label);
  }
  return release;
}

function withSlot(name, options, fn) {
  const release = waitForSlot(name, options);
  try {
    return fn();
  } finally {
    release();
  }
}

module.exports = { withSlot, waitForSlot, tryAcquire, defaultSlots, lockDir };
