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
const { buildOf, saveBuild, saveNotes, learnState, plansOf } = require('./build-kit.cjs');
const { clearRework } = require('./rework.cjs');
const { firstLine } = require('../redact.cjs');

const MAX_PLANS = 3;
const MIN_PARALLEL_GB = 40;
const MAX_LAUNCHES = 8;
const STEP_WEIGHT = 1000;

function progressOf(repo) {
  try {
    const { step, plans } = learnState(repo);
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
  const lock = run.spec.state === 'smoking' ? await leaseDevice(run) : null;
  if (run.spec.state === 'smoking' && !lock) return;
  const { launches = 0, best } = buildOf(run);
  saveBuild(run, { launches: launches + 1, best: launches ? best : progressOf(repo) });
  segment.launch(run, { slots: parallelSlots(run), extra: lock ? { serial: lock.serial, holder: lock.holder } : {} });
}

function gatesProblem(state) {
  if (state?.gates?.g1?.status !== 'approved') return 'worker đã đổi trạng thái cổng 1';
  return state.gates.g3?.status === 'pending' ? null : 'worker đã đổi trạng thái cổng 3';
}

function toSmoke(run) {
  closeWaits(run.db, run.spec.id, run.now, 'needs');
  decide(run, 'F03', 'spec-coded', { plans: plansOf(run.spec.data.repo).map(plan => plan.id) });
  clearRework(run);
  move(run, 'smoking', { data: segment.fresh(run.spec, 'smoke') });
}

function restart(run, reason, error) {
  const { launches = 0, best = 0 } = buildOf(run);
  const text = error ? `${error}; ${reason}` : reason;
  if (launches >= MAX_LAUNCHES) return park(run, `đoạn code đã chạy ${launches} lần mà chưa xong: ${text}`);
  const progress = progressOf(run.spec.data.repo);
  saveBuild(run, { best: Math.max(best, progress) });
  return segment.again(run, text, { progressed: progress > best });
}

function settleCode(run, state, error) {
  const { repo } = run.spec.data;
  if (state.step === 'smoke') return toSmoke(run);
  if (state.step === 'handoff') return park(run, 'worker đi qua bước chạy thử khi chưa được cấp thiết bị');
  const blocked = blockedOf(repo);
  if (hardOpen(run) && blocked) return move(run, 'provisional');
  return blocked ? needInput(run, blocked) : restart(run, `đang ở bước ${line(state.step, 20)}`, error);
}

async function settleSmoke(run, state, error, serial) {
  const { repo } = run.spec.data;
  const report = readSmoke(repo);
  const blocked = blockedOf(repo);
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

async function settle(run, job, error) {
  const { repo } = run.spec.data;
  const smoke = run.spec.state === 'smoking';
  if (smoke) await freeDevice(run);
  let state;
  try {
    state = learnState(repo);
    const problem = gatesProblem(state);
    if (problem) return park(run, problem);
    settleRound(run);
    const forged = collect(run);
    if (forged.length) return park(run, `worker tự chốt thay PO: ${forged.join(', ')}; chờ PO trả lời rồi dz spec retry ${run.spec.id}`);
    noteSelfChange(run);
  } catch (failure) {
    return restart(run, firstLine(failure), error);
  }
  return smoke ? settleSmoke(run, state, error, job.payload.serial) : settleCode(run, state, error);
}

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
