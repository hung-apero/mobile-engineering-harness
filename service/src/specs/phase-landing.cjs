const bugs = require('../bugs/store.cjs');
const kit = require('../bugs/phase-kit.cjs');
const { liveReady } = require('../bugs/live-claim.cjs');
const { removeBatchFiles } = require('../bugs/batch-files.cjs');
const { mergeBase } = require('./candidate.cjs');
const { approvalOf } = require('./phase-trial.cjs');
const { pendingChange } = require('./change.cjs');
const { openItems, toBuilding } = require('./provisional.cjs');
const { fresh } = require('./segment.cjs');
const { move, decide, park, closeWaits, nameOf } = require('./kit.cjs');
const { buildOf, saveBuild, batchIdOf, gitArgs, landingGit, sendBack } = require('./build-kit.cjs');
const { conflicted, baseConflicted, waitForBase, stillBlocked, retryAfterAdopt, branchOf } = require('./landing-retry.cjs');
const { keepApproved } = require('./release-hooks.cjs');
const { isClosed } = require('../bugs/closing.cjs');
const { firstLine } = require('../redact.cjs');

const batchesOf = run => bugs.listBatches(run.db, { project: run.project.key, version: buildOf(run).version });
const sameLanding = (run, batch) => batch.data.spec?.id === run.spec.id && batch.data.spec.serial === run.spec.data.serial;

async function readyFor(run) {
  const { rules, limits } = run.ctx.rulesFor(run.project.key);
  const batch = { id: null, project: run.project.key, version: buildOf(run).version, data: {} };
  return liveReady(kit.createRun(run.ctx, { project: run.project, rules, limits, batch, now: run.now }));
}

async function versionTip(run) {
  const { version } = buildOf(run);
  const row = bugs.ensureVersion(run.db, { project: run.project.key, version, now: run.now });
  const { workspace } = landingGit(run);
  await workspace.ensureMirror(gitArgs(run));
  return (await workspace.ensureVersionBranch(gitArgs(run, { version, branch: row.branch }))).sha;
}

function openLanding(run, startSha) {
  const { candidate, version } = buildOf(run);
  const { id } = run.spec;
  const lane = { branch: candidate.branch, commit: candidate.sha, keys: [], info: {}, state: 'approved', title: nameOf(run.spec) };
  const data = {
    phase: 'reviewing', live: run.live, round: 1, fixRounds: 0, parseErrors: 0, reviews: 0, lanes: [lane], notes: [], kept: {}, seen: {}, todo: [], startSha,
    spec: { id, serial: run.spec.data.serial, sha: candidate.sha },
  };
  const info = run.db.prepare("INSERT INTO batches (project, version, kind, state, keys, data, opened_at, updated_at) VALUES (?, ?, 'normal', 'running', '[]', ?, ?, ?)")
    .run(run.project.key, version, JSON.stringify(data), run.now, run.now);
  decide(run, 'F03', 'spec-landing', { batchId: Number(info.lastInsertRowid), sha: candidate.sha, startSha, version });
  return Number(info.lastInsertRowid);
}

async function enter(run) {
  if (!approvalOf(run) || buildOf(run).published.live !== run.live || pendingChange(run.spec) || openItems(run.spec).length) {
    move(run, 'po-trial', { data: fresh(run.spec, 'trial') });
    return true;
  }
  const { version, candidate } = buildOf(run);
  if (bugs.getVersion(run.db, run.project.key, version)?.state === 'closed' || isClosed(run.db, run.project.key, version)) {
    park(run, `bản ${version} đã đóng, không gộp thêm tính năng`);
    return true;
  }
  if (await stillBlocked(run)) return false;
  if (!(await readyFor(run))) return false;
  const known = batchesOf(run).find(batch => sameLanding(run, batch));
  const batchId = known?.id ?? openLanding(run, await mergeBase(gitArgs(run, { a: await versionTip(run), b: candidate.sha })));
  saveBuild(run, { landing: { batchId, serial: run.spec.data.serial } });
  return false;
}

function lastReason(run, batchId) {
  const rows = run.db.prepare("SELECT action, evidence FROM decisions WHERE project = ? AND json_extract(evidence, '$.batchId') = ? AND action <> 'batch-done' ORDER BY id DESC LIMIT 1").all(run.project.key, batchId);
  return rows.length ? `${rows[0].action} ${JSON.parse(rows[0].evidence).reason ?? ''}`.trim() : 'không rõ lý do';
}

async function lost(run, batch) {
  if (baseConflicted(run, batch)) return waitForBase(run, batch);
  if (retryAfterAdopt(run, batch)) return null;
  if (!conflicted(run, batch) || buildOf(run).conflicts) {
    return park(run, `không gộp được vào bản ${buildOf(run).version}: ${firstLine(lastReason(run, batch.id))}`);
  }
  const branch = branchOf(run);
  decide(run, 'F04', 'spec-conflict', { batchId: batch.id, branch });
  sendBack(run, `Xung đột khi gộp vào ${branch}: trên nhánh hiện tại chạy git fetch origin ${branch} rồi git merge FETCH_HEAD, gỡ xung đột giữ cả hai phía, build lại.`, `conflict-${batch.id}`);
  saveBuild(run, { conflicts: 1 });
  return toBuilding(run);
}

async function finish(run, batch) {
  try {
    keepApproved(run);
    await removeBatchFiles({ dzHome: run.ctx.dzHome, project: run.project, batchId: batchIdOf(run.spec) });
  } catch (error) {
    decide(run, 'X08', 'spec-cleanup-failed', { error: firstLine(error) });
  }
  closeWaits(run.db, run.spec.id, run.now);
  decide(run, 'Q01', 'spec-landed', { batchId: batch.id, sha: buildOf(run).candidate.sha, version: buildOf(run).version, pr: batch.data.pr?.url ?? null });
  move(run, batch.data.live ? 'done' : 'landed-dry', { data: { doneAt: run.now } });
}

async function landing(run) {
  const held = buildOf(run).landing;
  if (held?.serial !== run.spec.data.serial) return enter(run);
  const batch = bugs.getBatch(run.db, held.batchId);
  if (['open', 'running'].includes(batch.state)) return false;
  if (batch.state === 'abandoned') park(run, `đợt gộp #${batch.id} bị gác: ${firstLine(batch.data.reason ?? 'không rõ lý do')}`);
  else if (batch.data.delivered) await finish(run, batch);
  else await lost(run, batch);
  return true;
}

module.exports = { landing };
