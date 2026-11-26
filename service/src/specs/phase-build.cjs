const segment = require('./segment.cjs');
const { blockedOf, atGate, line } = require('./verify.cjs');
const { copyLocalFiles } = require('./local-files.cjs');
const { leaseDevice, freeDevice } = require('./device-lease.cjs');
const { readSmoke, readDebts } = require('./smoke-report.cjs');
const { collect, hardOpen, settleRound } = require('./provisional.cjs');
const { stepIndex } = require('../../vendor/learn-app/lib/looper-steps.cjs');
const { noteSelfChange } = require('./change.cjs');
const { closeParkedJob } = require('./phase-uidiff.cjs');
const { move, decide, park, needInput, closeWaits } = require('./kit.cjs');
const { buildOf, saveBuild, saveNotes, learnState } = require('./build-kit.cjs');
const { clearRework } = require('./rework.cjs');
const files = require('./repo-files.cjs');
const { ensureBranch, progressOf: planProgress, readResult, wantsChanges, resultProblem, branchOf } = require('./build-result.cjs');
const { firstLine } = require('../redact.cjs');

const MAX_PLANS = 3;
const MIN_PARALLEL_GB = 40;
const MAX_LAUNCHES = 8;
const STEP_WEIGHT = 1000;

function progressOf(run) {
  if (run.spec.state === 'building') return planProgress(run.spec.data.repo).done;
  try {
    const { step, plans } = learnState(run.spec.data.repo);
    return stepIndex(step) * STEP_WEIGHT + Object.values(plans ?? {}).filter(plan => plan?.status === 'merged').length;
  } catch {
    return 0;
  }
}

function parallelSlots(run) {
  const free = run.ctx.freeGb?.(run.ctx.dzHome);
  return typeof free === 'number' && free < MIN_PARALLEL_GB ? 1 : MAX_PLANS;
}

async function launchBuild(run) {
  const { repo } = run.spec.data;
  await copyLocalFiles({ project: run.project, repo });
  if (run.spec.state === 'building') await ensureBranch(repo, branchOf(run.spec));
  const lock = run.spec.state === 'smoking' ? await leaseDevice(run) : null;
  if (run.spec.state === 'smoking' && !lock) return;
  const { launches = 0, best } = buildOf(run);
  saveBuild(run, { launches: launches + 1, best: launches ? best : progressOf(run) });
  segment.launch(run, { slots: parallelSlots(run), extra: lock ? { serial: lock.serial, holder: lock.holder } : {} });
}

function gatesProblem(state) {
  if (state?.gates?.g1?.status !== 'approved') return 'worker đã đổi trạng thái cổng 1';
  return state.gates.g3?.status === 'pending' ? null : 'worker đã đổi trạng thái cổng 3';
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
  const progress = progressOf(run);
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

async function settleCode(run, error) {
  settleRound(run);
  noteSelfChange(run);
  const found = await lookBuild(run);
  if (found.type === 'tampered') return park(run, found.reason);
  if (found.type === 'blocked') return needInput(run, found);
  if (found.type === 'short') return restart(run, found.reason, error);
  return toSmoke(run, found.result);
}

async function settleSmoke(run, state, error, serial) {
  const { repo } = run.spec.data;
  const report = readSmoke(repo);
  const blocked = blockedOf(repo, 'headless-blocked.json');
  if (state.step !== 'handoff') {
    if (hardOpen(run) && blocked) return move(run, 'provisional');
    if (report?.result === 'blocked' && state.step === 'smoke') decide(run, 'F05', 'spec-smoke-blocked', { device: report.device });
    return blocked ? needInput(run, blocked) : restart(run, `đang ở bước ${line(state.step, 20)}`, error);
  }
  const problem = await atGate(run, repo, 'g3');
  if (problem) return blocked ? needInput(run, blocked) : restart(run, problem, error);
  if (!['pass', 'fail'].includes(report?.result) || !report.device.includes(serial)) return park(run, `smoke/report.md không phải kết quả chạy thử trên ${serial}`);
  const severe = report.errors.filter(item => item.severe).map(item => item.title);
  if (report.result === 'fail' && (severe.length || !report.errors.length)) return park(run, `chạy thử trên máy còn lỗi nặng, không gửi bản cài: ${severe.join('; ') || 'xem smoke/report.md'}`);
  const left = report.result === 'fail' ? report.errors.map(item => item.title) : [];
  saveNotes(run, 'smoke', left);
  saveNotes(run, 'debts', readDebts(repo));
  if (left.length) decide(run, 'S05', 'spec-smoke-left', { errors: left });
  move(run, 'uidiff', { data: { ...segment.fresh(run.spec, 'uidiff') } });
  return saveBuild(run, { uidiff: { round: 1, notes: [] } });
}

async function settleOldSmoke(run, job, error) {
  await freeDevice(run);
  let state;
  try {
    state = learnState(run.spec.data.repo);
    const problem = gatesProblem(state);
    if (problem) return park(run, problem);
    settleRound(run);
    const forged = collect(run);
    if (forged.length) return park(run, `worker tự chốt thay PO: ${forged.join(', ')}; chờ PO trả lời rồi dz spec retry ${run.spec.id}`);
    noteSelfChange(run);
  } catch (failure) {
    return restart(run, firstLine(failure), error);
  }
  return settleSmoke(run, state, error, job.payload.serial);
}

const settle = (run, job, error) => (run.spec.state === 'smoking' ? settleOldSmoke(run, job, error) : settleCode(run, error));

async function advanceBuild(run) {
  const now = segment.state(run);
  if (now.type === 'waiting') return false;
  if (now.type === 'missing') {
    await launchBuild(run);
    return false;
  }
  if (now.type === 'parked') {
    const { id, parkReason } = now.job;
    if (run.spec.state === 'building') {
      park(run, parkReason ?? 'việc bị gác', { jobId: id });
      return false;
    }
    await freeDevice(run);
    closeParkedJob(run, now.job);
    park(run, parkReason ?? 'việc bị gác');
    return true;
  }
  await settle(run, now.job, now.error);
  return true;
}

module.exports = { advanceBuild, MIN_PARALLEL_GB };
