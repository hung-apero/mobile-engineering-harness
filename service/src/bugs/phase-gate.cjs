const results = require('./job-results.cjs');
const { nextBatch, nextBatchAll } = require('./outcome.cjs');
const { mergeLanes, resetToBefore } = require('./phase-merge.cjs');
const { save, decideOnce, ensureJob, findJob, isHeld, isWaiting, gitOf, gitArgs, activeKeys } = require('./phase-kit.cjs');

const MAX_RUNS = 4;

async function giveUp(run, reason) {
  await resetToBefore(run);
  decideOnce(run, null, 'gate-red', 'F01', 'gate-red', { reason });
  await nextBatchAll(run, activeKeys(run), { code: 'F01', reason: `Cổng gộp đỏ: ${reason}` });
  save(run, { phase: 'done', landing: false, lanes: [] });
  return true;
}

async function nextTrial(run, reason) {
  const { lanes, gateRun, trial, merges } = run.batch.data;
  const next = trial === null ? 0 : trial + 1;
  if (lanes.length === 1 || gateRun >= MAX_RUNS || next >= lanes.length) return giveUp(run, reason);
  const { result, landed } = await mergeLanes(run, lanes.filter((_, i) => i !== next), merges + 1);
  const patch = { merges: merges + 1, trial: next };
  if (!result.ok || landed.length === 0) {
    save(run, patch);
    return nextTrial(run, reason);
  }
  decideOnce(run, null, `gate-g${gateRun}`, 'F01', 'gate-bisect', { without: lanes[next].branch, reason });
  save(run, { ...patch, sha: result.sha, gateRun: gateRun + 1, trialLanes: landed.map(l => l.branch) });
  return true;
}

async function passed(run, note = null) {
  const { lanes, trial, trialLanes, sha } = run.batch.data;
  for (const lane of lanes.filter(l => !trialLanes.includes(l.branch))) {
    const culprit = trial !== null && lane.branch === lanes[trial].branch;
    const info = culprit
      ? { code: 'F01', reason: `Nhánh ${lane.branch} làm cổng gộp đỏ` }
      : { code: 'F04', reason: `Nhánh ${lane.branch} xung đột khi gộp lại` };
    for (const key of lane.keys) await nextBatch(run, key, info);
  }
  decideOnce(run, null, 'gate-green', 'F03', 'gate-green', { sha, without: trial === null ? null : lanes[trial].branch, ...(note && { note }) });
  save(run, { phase: 'building', lanes: lanes.filter(l => trialLanes.includes(l.branch)) });
  return true;
}

async function gating(run) {
  const { landing } = gitOf(run);
  const { sha, startSha, gateRun, lanes, trialLanes } = run.batch.data;
  const suffix = `g${gateRun}`;
  let job = findJob(run, 'gate', `${run.batch.id}#${suffix}`);
  if (!job) {
    if (isHeld(run)) return false;
    const { tree } = await landing.versionWorktree(gitArgs(run, { batchId: run.batch.id, sha, reuse: gateRun > 1 }));
    const commits = lanes.filter(l => trialLanes.includes(l.branch)).map(l => l.commit);
    const changed = await landing.changedFiles(gitArgs(run, { from: startSha, commits }));
    job = ensureJob(run, { kind: 'gate', suffix, payload: results.gatePayload(run, tree, changed) });
  }
  if (isWaiting(job)) return false;
  const judged = results.judgeGateJob(run, job);
  if (judged.broken) {
    save(run, { phase: 'parked', reason: `Việc kiểm cổng #${job.id}: ${judged.reason}` });
    return true;
  }
  return judged.ok ? passed(run, judged.note) : nextTrial(run, judged.reason);
}

module.exports = { gating, MAX_RUNS };
