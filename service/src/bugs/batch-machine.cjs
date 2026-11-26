const kv = require('../kv.cjs');
const store = require('./store.cjs');
const { isPaused } = require('../health.cjs');
const { intakeState } = require('../intake-state.cjs');
const { resolveWait } = require('../pings.cjs');
const { firstLine } = require('../redact.cjs');
const { parkRequested, clearPark } = require('./park-request.cjs');
const { liveReady } = require('./live-claim.cjs');
const { openBatchWait } = require('./dry-traces.cjs');
const { createRun, decide, save } = require('./phase-kit.cjs');
const { claimBatch, claiming } = require('./phase-claim.cjs');
const { fixing } = require('./phase-fix.cjs');
const { reviewing } = require('./phase-review.cjs');
const { merging } = require('./phase-merge.cjs');
const { gating } = require('./phase-gate.cjs');
const { building, publishing } = require('./phase-build.cjs');
const { distributing, delivering } = require('./phase-deliver.cjs');
const { done, parked, modeChanged, toolsOf } = require('./phase-end.cjs');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const BACKOFF_MINUTES = [3, 6, 12, 15];
const REPORT_MS = 30 * MINUTE;
const PARK_REASON = 'người vận hành yêu cầu gác';
const PHASES = { claiming, fixing, reviewing, merging, gating, building, publishing, distributing, delivering, done, parked };

const errorKey = id => `bug-batch-error:${id}`;

function noteError(run, phase, error) {
  const previous = kv.get(run.db, errorKey(run.batch.id)) ?? { count: 0, firstAt: run.now, waitId: null };
  const count = previous.count + 1;
  const until = run.now + BACKOFF_MINUTES[Math.min(count, BACKOFF_MINUTES.length) - 1] * MINUTE;
  let { waitId } = previous;
  if (waitId === null && run.now - previous.firstAt >= REPORT_MS) {
    const subject = `Đợt bug ${run.batch.id} (${run.project.key}) lỗi quá 30 phút ở bước ${phase}: ${firstLine(error)}`;
    waitId = openBatchWait(run, { role: 'dev', subject });
  }
  kv.set(run.db, errorKey(run.batch.id), { count, firstAt: previous.firstAt, until, waitId }, run.now);
  decide(run, 'X06', 'batch-error', { phase, count, error: firstLine(error) });
  run.ctx.log?.('batch-error', { project: run.project.key, batchId: run.batch.id, phase, error: firstLine(error), stack: String(error?.stack ?? '').split('\n').slice(1, 4) });
}

function clearError(run) {
  const known = kv.get(run.db, errorKey(run.batch.id));
  if (!known) return;
  if (known.waitId !== null) resolveWait(run.db, known.waitId, run.now);
  kv.del(run.db, errorKey(run.batch.id));
}

async function pruneDaily(run) {
  const { ctx, db, project, now } = run;
  const key = `bug-prune:${project.key}`;
  if (now - (kv.get(db, key) ?? 0) < DAY) return;
  kv.set(db, key, now, now);
  try {
    const removed = await toolsOf(run).pruneAbandoned({ db, dzHome: ctx.dzHome, project, now });
    if (removed.length) decide(run, 'X05', 'batch-files-pruned', { removed });
  } catch (error) {
    ctx.log?.('batch-prune-error', { project: project.key, error: firstLine(error) });
  }
}

async function claim(run) {
  await pruneDaily(run);
  if (isPaused(run.db, run.project.key) || !intakeState(run.ctx, run.rules, run.now).open) return false;
  return (await liveReady(run)) && claimBatch(run);
}

function startParking(run) {
  const { state, data } = run.batch;
  const half = data.phase === 'distributing' && run.live;
  const patch = { phase: 'parked', reason: half ? `${PARK_REASON} lúc đang gửi bản cài, cần kiểm Firebase` : PARK_REASON };
  if (state === 'open') claimBatch(run, patch);
  else if (!['done', 'parked'].includes(data.phase)) save(run, patch);
  clearPark(run.db, run.batch.id);
}

const sameMode = run => run.batch.data.phase === 'done' || run.batch.data.live === run.live;

async function advanceBatch(ctx, { project, rules, limits, batch, now }) {
  const current = store.getBatch(ctx.db, batch.id);
  if (!current || store.FINISHED.includes(current.state)) return { changed: false, phase: current?.data.phase ?? null };
  const run = createRun(ctx, { project, rules, limits, batch: current, now });
  const phase = current.data.phase ?? 'open';
  const parking = parkRequested(ctx.db, current.id);
  if (!parking && now < (kv.get(ctx.db, errorKey(current.id))?.until ?? 0)) return { changed: false, phase };
  try {
    if (parking) startParking(run);
    else if (current.state === 'open' && !(await claim(run))) return { changed: false, phase };
    const step = sameMode(run) ? PHASES[run.batch.data.phase] : modeChanged;
    if (!step) throw new Error(`bước không hợp lệ: ${run.batch.data.phase}`);
    const changed = (await step(run)) === true;
    clearError(run);
    return { changed, phase: run.batch.data.phase };
  } catch (error) {
    noteError(run, run.batch.data.phase ?? phase, error);
    return { changed: false, phase: run.batch.data.phase ?? phase, error: firstLine(error) };
  }
}

module.exports = { advanceBatch, errorKey };
