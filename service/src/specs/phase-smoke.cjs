const jobs = require('../jobs.cjs');
const results = require('../bugs/job-results.cjs');
const { runGit } = require('../bugs/git.cjs');
const { checkRepo } = require('./wire.cjs');
const { leaseDevice, freeDevice } = require('./device-lease.cjs');
const { readResult } = require('./build-result.cjs');
const { fixRound } = require('./phase-code-review.cjs');
const { closeParkedJob } = require('./phase-uidiff.cjs');
const { stateOf, fresh } = require('./segment.cjs');
const { move, decide, park, findJob } = require('./kit.cjs');
const { saveBuild, saveNotes, batchIdOf } = require('./build-kit.cjs');

const smokeKey = spec => `${batchIdOf(spec)}#smoke-${spec.data.segment?.serial ?? 0}`;
const jobOf = run => findJob(run.db, { project: run.project.key, kind: 'build', key: smokeKey(run.spec) });

async function launch(run) {
  const { repo } = run.spec.data;
  await checkRepo(repo);
  const lock = await leaseDevice(run);
  if (!lock) return false;
  const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
  const payload = { batchId: batchIdOf(run.spec), worktree: repo, sha, smoke: { specId: run.spec.id, serial: lock.serial, holder: lock.holder } };
  jobs.enqueue(run.db, { project: run.project.key, kind: 'build', key: smokeKey(run.spec), priority: 1, slots: 1, payload }, run.now);
  return false;
}

function passed(run, job) {
  const { sha, smoke } = job.payload;
  decide(run, 'F05', 'spec-smoke-passed', { sha, serial: smoke.serial });
  saveNotes(run, 'debts', readResult(run.spec.data.repo)?.review.findings ?? []);
  move(run, 'uidiff', { data: fresh(run.spec, 'uidiff') });
  saveBuild(run, { uidiff: { round: 1, notes: [] } });
}

async function settle(run, job) {
  await freeDevice(run);
  if (job.state === 'parked') closeParkedJob(run, job);
  const judged = job.state === 'parked' ? { broken: true, reason: job.parkReason ?? 'việc chạy thử bị gác' } : await results.judgeBuildJob(run, job);
  if (judged.broken) return park(run, `chạy thử không chạy được: ${judged.reason}`);
  if (judged.ok) return passed(run, job);
  decide(run, 'F05', 'spec-smoke-red', { step: judged.failedStep, reason: judged.reason.slice(0, 300) });
  return fixRound(run, `Chạy thử đỏ: ${judged.reason}`);
}

async function smoking(run) {
  const now = stateOf(jobOf(run));
  if (now.type === 'waiting') return false;
  if (now.type === 'missing') return launch(run);
  await settle(run, now.job);
  return true;
}

module.exports = { smoking, smokeKey };
