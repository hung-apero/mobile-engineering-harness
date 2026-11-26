const store = require('./store.cjs');
const cleanup = require('./cleanup.cjs');
const { openBatchWait } = require('./dry-traces.cjs');
const { firstLine } = require('../redact.cjs');
const { giveDev } = require('./outcome.cjs');
const { resetToBefore } = require('./phase-merge.cjs');
const { oneLine } = require('./comment-text.cjs');
const { save, mark, decide, decideOnce, activeKeys } = require('./phase-kit.cjs');

const target = run => ({ dzHome: run.ctx.dzHome, project: run.project, batchId: run.batch.id });
const toolsOf = run => run.ctx.bugs.cleanup ?? cleanup;

async function attempt(run, name, fn) {
  try {
    return await fn();
  } catch (error) {
    decideOnce(run, null, `cleanup-${name}`, 'X08', 'cleanup-failed', { step: name, error: firstLine(error) });
    return null;
  }
}

async function done(run) {
  const tools = toolsOf(run);
  await attempt(run, 'devices', () => tools.releaseDevices(target(run)));
  await attempt(run, 'files', () => tools.removeBatchFiles(target(run)));
  const { delivered = false } = run.batch.data;
  if (!store.transitionBatch(run.db, run.batch.id, 'running', 'done', run.now)) return false;
  decide(run, 'Q01', 'batch-done', { delivered });
  run.batch = store.getBatch(run.db, run.batch.id);
  return true;
}

async function lowerVersion(run) {
  const { landing, pushed, before, live } = run.batch.data;
  if (landing && before && !(pushed && live)) {
    try {
      await resetToBefore(run);
    } catch (error) {
      if (!['PUSHED', 'REF_MOVED', 'INVALID'].includes(error.code)) throw error;
      decideOnce(run, null, 'lower', 'X08', 'reset-refused', { error: firstLine(error) });
    }
  }
  if (landing) save(run, { landing: false });
}

async function releaseAll(run) {
  const tools = toolsOf(run);
  await tools.closeJobs({ ...target(run), db: run.db, now: run.now });
  await attempt(run, 'processes', () => tools.stopProcesses(target(run)));
  await attempt(run, 'devices', () => tools.releaseDevices(target(run)));
  await lowerVersion(run);
}

async function parked(run) {
  const reason = oneLine(run.batch.data.reason ?? 'không rõ lý do', 300);
  mark(run, null, 'park-wait', () => {
    decide(run, 'X08', 'batch-parked', { reason });
    openBatchWait(run, { role: 'dev', subject: `Đợt bug ${run.batch.id} (${run.project.key} ${run.batch.version}) bị gác: ${reason}` });
  });
  await releaseAll(run);
  for (const key of activeKeys(run)) await giveDev(run, key, { code: 'X08', reason: `Đợt bug bị gác: ${reason}`, wait: false });
  if (!store.transitionBatch(run.db, run.batch.id, 'running', 'abandoned', run.now)) return false;
  run.batch = store.getBatch(run.db, run.batch.id);
  return true;
}

async function modeChanged(run) {
  const { phase, live } = run.batch.data;
  const now = run.live;
  run.live = live === true;
  mark(run, null, 'mode-changed', () => {
    decide(run, 'X08', 'mode-changed', { from: live ?? null, to: now, phase });
    if (!run.live || phase !== 'distributing') return;
    openBatchWait(run, { role: 'dev', subject: `Đợt bug ${run.batch.id} (${run.project.key} ${run.batch.version}) bị bỏ giữa lúc gửi bản cài, cần kiểm Firebase` });
  });
  await releaseAll(run);
  if (!store.transitionBatch(run.db, run.batch.id, 'running', 'abandoned', run.now)) return false;
  run.batch = store.getBatch(run.db, run.batch.id);
  return true;
}

module.exports = { done, parked, modeChanged, toolsOf };
