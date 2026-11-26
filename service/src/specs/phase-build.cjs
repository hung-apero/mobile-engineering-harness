const segment = require('./segment.cjs');
const files = require('./repo-files.cjs');
const { blockedOf, line } = require('./verify.cjs');
const { copyLocalFiles } = require('./local-files.cjs');
const { settleRound } = require('./provisional.cjs');
const { noteSelfChange } = require('./change.cjs');
const { move, decide, park, needInput, closeWaits } = require('./kit.cjs');
const { buildOf, saveBuild } = require('./build-kit.cjs');
const { clearRework } = require('./rework.cjs');
const { ensureBranch, progressOf, readResult, wantsChanges, resultProblem, branchOf } = require('./build-result.cjs');
const { firstLine } = require('../redact.cjs');

const MAX_PLANS = 3;
const MIN_PARALLEL_GB = 40;
const MAX_LAUNCHES = 8;

const doneOf = run => progressOf(run.spec.data.repo).done;

function parallelSlots(run) {
  const free = run.ctx.freeGb?.(run.ctx.dzHome);
  return typeof free === 'number' && free < MIN_PARALLEL_GB ? 1 : MAX_PLANS;
}

async function launchBuild(run) {
  const { repo } = run.spec.data;
  await copyLocalFiles({ project: run.project, repo });
  await ensureBranch(repo, branchOf(run.spec));
  const { launches = 0, best } = buildOf(run);
  saveBuild(run, { launches: launches + 1, best: launches ? best : doneOf(run) });
  segment.launch(run, { slots: parallelSlots(run) });
}

function toSmoke(run, result) {
  closeWaits(run.db, run.spec.id, run.now, 'needs');
  decide(run, 'F03', 'spec-coded', { plans: result.plans, commit: result.commit });
  clearRework(run);
  move(run, 'smoking', { data: segment.fresh(run.spec, 'smoke') });
}

function restart(run, reason, error) {
  const { launches = 0, best = 0 } = buildOf(run);
  const text = error ? `${error}; ${reason}` : reason;
  if (launches >= MAX_LAUNCHES) return park(run, `đoạn code đã chạy ${launches} lần mà chưa xong: ${text}`);
  const progress = doneOf(run);
  saveBuild(run, { best: Math.max(best, progress) });
  return segment.again(run, text, { progressed: progress > best });
}

async function inspectBuild(run) {
  const { repo, segment: current } = run.spec.data;
  if (current.inputsSha && files.inputsSha(repo) !== current.inputsSha) return { type: 'tampered', reason: 'worker đã sửa .harness-run/inputs' };
  const blocked = blockedOf(repo);
  if (blocked) return blocked;
  const checked = await run.ctx.specs.check(run.project, repo, 'build');
  if (checked.problems.length) return { type: 'short', reason: line(checked.problems.join('; '), 500) };
  const problem = await resultProblem(run);
  if (problem) return { type: 'short', reason: problem };
  const result = readResult(repo);
  if (wantsChanges(result)) return { type: 'short', reason: line(`review của harness còn yêu cầu sửa: ${result.review.findings.slice(0, 5).join('; ') || result.review.verdict}`, 500) };
  return { type: 'coded', result };
}

async function lookBuild(run) {
  try {
    return await inspectBuild(run);
  } catch (error) {
    if (error.code === 'HARNESS') return { type: 'blocked', kind: 'harness', role: 'dev', reason: firstLine(error), missing: [] };
    return { type: 'short', reason: firstLine(error) };
  }
}

async function settle(run, error) {
  settleRound(run);
  noteSelfChange(run);
  const found = await lookBuild(run);
  if (found.type === 'tampered') return park(run, found.reason);
  if (found.type === 'blocked') return needInput(run, found);
  if (found.type === 'short') return restart(run, found.reason, error);
  return toSmoke(run, found.result);
}

async function advanceBuild(run) {
  const now = segment.state(run);
  if (now.type === 'waiting') return false;
  if (now.type === 'missing') {
    await launchBuild(run);
    return false;
  }
  if (now.type === 'parked') {
    park(run, now.job.parkReason ?? 'việc bị gác', { jobId: now.job.id });
    return false;
  }
  await settle(run, now.error);
  return true;
}

module.exports = { advanceBuild, MIN_PARALLEL_GB };
