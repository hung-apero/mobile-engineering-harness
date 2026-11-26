const fs = require('fs');

const STALE_MS = 10000;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (error) {
      // Windows answers EPERM/EACCES while another process is deleting the lock file.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS) fs.rmSync(lockPath, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`Không lấy được khóa ${lockPath}`);
      pause(5 + Math.floor(Math.random() * 20));
    }
  }
}

function withLock(lockPath, fn, timeoutMs = 5000) {
  const handle = acquire(lockPath, timeoutMs);
  try {
    return fn();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  }
}

module.exports = { withLock };
