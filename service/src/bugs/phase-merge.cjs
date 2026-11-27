const { firstLine } = require('../redact.cjs');
const { openBatchWait } = require('./dry-traces.cjs');
const { nextBatch, nextBatchAll, giveDev } = require('./outcome.cjs');
const { save, mark, decide, decideOnce, effect, gitOf, gitArgs, branchOf, activeKeys } = require('./phase-kit.cjs');

const LANDED = ['already_merged'];

async function resetToBefore(run) {
  const { before } = run.batch.data;
  if (!before) return;
  const { landing } = gitOf(run);
  const versionBranch = branchOf(run);
  const tip = await landing.versionTip(gitArgs(run, { versionBranch }));
  if (tip !== before) await landing.resetVersion(gitArgs(run, { versionBranch, from: tip, to: before }));
}

async function mergeLanes(run, lanes, number) {
  const { merge } = gitOf(run);
  const { startSha } = run.batch.data;
  const branches = lanes.map(({ branch, commit }) => ({ branch, commit }));
  const result = await effect(run, null, `merge-${number}`, async () => {
    await resetToBefore(run);
    return merge.mergeBatch(gitArgs(run, { versionBranch: branchOf(run), branches, startSha, skipConflicting: true }));
  });
  if (!result.ok) return { result, landed: [], skipped: [] };
  const skipped = result.skipped.filter(s => !LANDED.includes(s.code));
  const codes = new Map(skipped.map(s => [s.branch, s.code]));
  return {
    result,
    landed: lanes.filter(l => !codes.has(l.branch)),
    skipped: lanes.filter(l => codes.has(l.branch)).map(lane => ({ lane, code: codes.get(lane.branch) })),
  };
}

async function settleSkipped(run, skipped) {
  for (const { lane, code } of skipped) {
    for (const key of lane.keys) {
      if (code === 'conflict') await nextBatch(run, key, { code: 'F04', reason: `Nhánh ${lane.branch} xung đột khi gộp` });
      else await giveDev(run, key, { code: 'F03', reason: `Không gộp được ${lane.branch}: ${code}` });
    }
  }
}

async function prepare(run) {
  const { workspace, landing } = gitOf(run);
  await workspace.ensureMirror(gitArgs(run));
  if (run.batch.data.before) return;
  const before = await landing.versionTip(gitArgs(run, { versionBranch: branchOf(run) }));
  save(run, { before, merges: 1 });
}

async function baseConflict(run, files) {
  mark(run, null, 'base-conflict', () => {
    decide(run, 'F04', 'base-conflict', { files });
    openBatchWait(run, { role: 'dev', subject: `Nhánh gốc xung đột với ${branchOf(run)}, cần dev gỡ tay` });
  });
  await nextBatchAll(run, activeKeys(run), { code: 'F04', reason: 'Nhánh gốc xung đột với nhánh version' });
}

async function startLost(run, error) {
  decideOnce(run, null, 'start-lost', 'F04', 'start-lost', { startSha: run.batch.data.startSha, error: firstLine(error) });
  await nextBatchAll(run, activeKeys(run), { code: 'F04', reason: 'Commit gốc của đợt không còn trên nhánh version' });
  save(run, { phase: 'done', landing: false, lanes: [] });
  return true;
}

async function merging(run) {
  await prepare(run);
  const { lanes, merges } = run.batch.data;
  let outcome;
  try {
    outcome = await mergeLanes(run, lanes, merges);
  } catch (error) {
    if (error.code !== 'INVALID') throw error;
    return startLost(run, error);
  }
  const { result, landed, skipped } = outcome;
  if (!result.ok) {
    await baseConflict(run, result.files);
    save(run, { phase: 'done', landing: false, lanes: [] });
    return true;
  }
  await settleSkipped(run, skipped);
  if (landed.length === 0) {
    save(run, { phase: 'done', landing: false, lanes: [] });
    return true;
  }
  mark(run, null, 'merged', () => decide(run, 'F03', 'merged', { sha: result.sha, lanes: landed.map(l => l.branch) }));
  save(run, { phase: 'gating', lanes: landed, sha: result.sha, gateRun: 1, trial: null, trialLanes: landed.map(l => l.branch) });
  return true;
}

module.exports = { merging, mergeLanes, resetToBefore };
