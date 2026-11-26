const fs = require('node:fs');
const path = require('node:path');
const jobs = require('./jobs.cjs');
const kv = require('./kv.cjs');
const { workingDayKey } = require('./work-hours.cjs');

const KEEP_MS = 30 * 24 * 3600 * 1000;
const LAST = 'logs-pruned';
const WORKER_LOG = /^(\d+)-\d+-[^/]*\.jsonl$/;
const BATCH_DIR = /^[A-Z][A-Z0-9]+-\d+$/;
const FINISHED = ['done', 'failed'];

function pruneBatchDirs(dir, now) {
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return 0;
  let count = 0;
  for (const name of fs.readdirSync(dir).filter(n => BATCH_DIR.test(n))) {
    const target = path.join(dir, name);
    const info = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.mtimeMs > now - KEEP_MS) continue;
    fs.rmSync(target, { recursive: true, force: true });
    count++;
  }
  return count;
}

function pruneLogs(ctx, now) {
  const day = workingDayKey(now);
  if (kv.get(ctx.db, LAST) === day) return;
  kv.set(ctx.db, LAST, day, now);
  const dir = path.join(ctx.dzHome, 'logs');
  let count = pruneBatchDirs(path.join(dir, 'batches'), now);
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(WORKER_LOG);
    if (!match || !FINISHED.includes(jobs.getJob(ctx.db, Number(match[1]))?.state)) continue;
    const file = path.join(dir, name);
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || info.mtimeMs > now - KEEP_MS) continue;
    fs.rmSync(file, { force: true });
    count++;
  }
  if (count) ctx.log('logs-pruned', { count });
}

module.exports = { pruneLogs };
