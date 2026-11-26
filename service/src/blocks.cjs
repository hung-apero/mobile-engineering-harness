const kv = require('./kv.cjs');
const jobs = require('./jobs.cjs');
const { openWait, resolveWait } = require('./pings.cjs');
const { record } = require('./decisions.cjs');
const { projectBlocked } = require('./health.cjs');

const PARKED = 'wait:job:';
const BLOCK = 'block:';
const SANDBOX = 'sandbox:';

function closeWait(db, key, now) {
  const waitId = kv.get(db, key);
  if (waitId === null) return;
  resolveWait(db, waitId, now);
  kv.del(db, key);
}

function syncParked(db, now, isInactive = () => false) {
  const open = new Set();
  for (const job of jobs.listJobs(db, { states: ['parked'] })) {
    if (isInactive(job.project)) continue;
    const key = PARKED + job.id;
    open.add(key);
    if (kv.get(db, key) !== null) continue;
    const subject = `Việc #${job.id} (${job.project}) đang gác: ${job.parkReason}`;
    kv.transaction(db, () => kv.set(db, key, openWait(db, { project: job.project, role: 'dev', subject }, now), now));
  }
  for (const key of kv.keys(db, PARKED)) {
    if (!open.has(key)) kv.transaction(db, () => closeWait(db, key, now));
  }
}

function clearParked(db, jobId, now) {
  kv.transaction(db, () => closeWait(db, PARKED + jobId, now));
}

function trackBlock(db, project, { rules, version }, now) {
  return kv.transaction(db, () => {
    const key = BLOCK + project;
    if (!projectBlocked(db, project, rules)) {
      closeWait(db, key, now);
      return false;
    }
    if (kv.get(db, key) !== null) return true;
    const failures = rules.X07.max_consecutive_failures;
    record(db, { project, code: 'X07', ruleVersion: version, evidence: { failures }, action: 'project-blocked' }, now);
    const subject = `Project ${project} dừng nhận việc (X07): ${failures} việc lỗi liên tiếp`;
    kv.set(db, key, openWait(db, { project, role: 'dev', subject }, now), now);
    return true;
  });
}

function trackSandbox(db, project, refused, now) {
  kv.transaction(db, () => {
    const key = SANDBOX + project;
    if (!refused) closeWait(db, key, now);
    else if (kv.get(db, key) === null) kv.set(db, key, openWait(db, { project, role: 'dev', subject: `Project ${project} đang live nhưng máy thiếu sandbox-exec, không mở việc` }, now), now);
  });
  return refused;
}

function closeInactiveBlocks(db, isInactive, now) {
  for (const prefix of [BLOCK, SANDBOX]) {
    for (const key of kv.keys(db, prefix)) {
      if (isInactive(key.slice(prefix.length))) kv.transaction(db, () => closeWait(db, key, now));
    }
  }
}

function clearBlock(db, project, now) {
  closeWait(db, BLOCK + project, now);
}

module.exports = { syncParked, clearParked, trackBlock, trackSandbox, closeInactiveBlocks, clearBlock };
