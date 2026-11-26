const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const table = require('../process-table.cjs');
const jobs = require('../jobs.cjs');
const { clearParked } = require('../blocks.cjs');
const { stopWorker } = require('../worker.cjs');
const { batchDir } = require('./landing.cjs');
const { removeBatchFiles, pruneAbandoned } = require('./batch-files.cjs');
const { check, BATCH_ID } = require('./git.cjs');

const GRACE_MS = 5000;
const KINDS = ['bug', 'review', 'gate', 'build'];
const OPEN = ['queued', 'parked', 'starting', 'running'];
const POLL_MS = 100;
const RELEASE = [
  'import sys', 'sys.path.insert(0, sys.argv[1])', 'import devices', 'freed = []',
  'for serial, entry in devices.snapshot().items():',
  '    if entry["holder"].startswith(sys.argv[2]) and devices.release(serial, entry["holder"]): freed.append(serial)',
  'print("\\n".join(sorted(freed)))',
].join('\n');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function exec(bin, args, { env, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout: 30000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (!error || okCodes.includes(error.code)) return resolve(stdout);
      reject(new Error(`${path.basename(bin)}: ${error.message.split('\n')[0]}`));
    });
  });
}

async function releaseDevices({ dzHome, batchId }) {
  const stateDir = path.join(dzHome, 'bug-fix-state');
  const prefix = `batch:${check(BATCH_ID, batchId, 'batch.id')}:`;
  if (!fs.existsSync(path.join(stateDir, 'devices.json'))) return [];
  const scripts = path.join(dzHome, 'harness', 'skills', 'bug-fix', 'scripts');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, BUG_FIX_STATE_DIR: stateDir };
  const out = await exec('python3', ['-I', '-B', '-c', RELEASE, scripts, prefix], { env });
  return out.split('\n').filter(Boolean);
}

function parseCwds(text) {
  const found = [];
  let pid = null;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid !== null) found.push({ pid, cwd: line.slice(1) });
  }
  return found;
}

async function processesIn(dir, lsof) {
  const inside = parseCwds(await lsof()).filter(({ pid, cwd }) => pid > 1 && pid !== process.pid && (cwd === dir || cwd.startsWith(dir + path.sep)));
  const rows = table.readTable();
  return new Map(inside.map(({ pid }) => rows.find(r => r.pid === pid && !r.zombie)).filter(Boolean).map(r => [r.pid, r.start]));
}

async function stopProcesses({ dzHome, project, batchId, graceMs = GRACE_MS, lsof }) {
  const dir = batchDir({ dzHome, project, batchId });
  const list = lsof ?? (() => exec('lsof', ['-w', '-a', '-d', 'cwd', '-u', String(process.getuid()), '-Fpn'], { okCodes: [0, 1] }));
  const before = await processesIn(dir, list);
  if (before.size === 0) return [];
  table.signalRecorded(before, 'SIGTERM');
  const end = Date.now() + graceMs;
  while (Date.now() < end && table.liveRecorded(table.readTable(), before).length) await sleep(POLL_MS);
  table.signalRecorded(before, 'SIGKILL');
  return [...before.keys()];
}

async function stopJob(job) {
  if (job.state === 'starting') throw new Error(`việc #${job.id} đang mở, chờ rồi gác đợt`);
  if (job.state !== 'running' || !table.isSameProcess(job.pid, job.pidStart)) return;
  if (!(await stopWorker(job.pid, job.pidStart, GRACE_MS)) && table.isSameProcess(job.pid, job.pidStart)) throw new Error(`không dừng được việc #${job.id}`);
}

async function closeJobs({ db, project, batchId, now }) {
  const mine = jobs.listJobs(db, { states: OPEN, project: project.key })
    .filter(job => KINDS.includes(job.kind) && job.key.startsWith(`${batchId}#`));
  const order = job => OPEN.indexOf(job.state);
  for (const job of mine.sort((a, b) => order(a) - order(b))) {
    await stopJob(job);
    const { changes } = db.prepare("UPDATE jobs SET state = 'failed', result = ?, finished_at = NULL, slots_granted = 0 WHERE id = ? AND state = ?")
      .run(JSON.stringify({ error: 'batch_closed' }), job.id, job.state);
    if (changes === 0) throw new Error(`việc #${job.id} vừa đổi trạng thái`);
    clearParked(db, job.id, now);
  }
  return mine.map(job => job.id);
}

module.exports = { closeJobs, releaseDevices, stopProcesses, removeBatchFiles, pruneAbandoned, stopJob };
