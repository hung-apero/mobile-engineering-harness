const fs = require('node:fs');
const { transaction } = require('./kv.cjs');
const { isSameProcess, processStart } = require('./worker.cjs');

let identity = null;

function self() {
  if (identity) return identity;
  const pidStart = processStart(process.pid);
  if (!pidStart) throw new Error('không đọc được giờ khởi động của tiến trình');
  identity = { pid: process.pid, pidStart };
  return identity;
}

function lockOwner(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { pid, pidStart } = JSON.parse(text);
    return Number.isInteger(pid) && typeof pidStart === 'string' ? { pid, pidStart } : null;
  } catch {
    return null;
  }
}

function liveOwner(file) {
  const owner = lockOwner(file);
  return owner && isSameProcess(owner.pid, owner.pidStart) ? owner : null;
}

function write(file, text) {
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
}

function acquireLock(db, file) {
  const text = JSON.stringify(self());
  return transaction(db, () => {
    const owner = liveOwner(file);
    if (owner) return { ok: false, pid: owner.pid };
    if (!fs.existsSync(file)) {
      write(file, text);
      return { ok: true };
    }
    const temp = `${file}.${process.pid}`;
    fs.rmSync(temp, { force: true });
    write(temp, text);
    fs.renameSync(temp, file);
    return { ok: true };
  });
}

function ownsLock(file) {
  const owner = lockOwner(file);
  return owner !== null && owner.pid === self().pid && owner.pidStart === self().pidStart;
}

function releaseLock(db, file) {
  transaction(db, () => {
    if (ownsLock(file)) fs.unlinkSync(file);
  });
}

module.exports = { acquireLock, releaseLock, ownsLock, lockOwner, liveOwner };
