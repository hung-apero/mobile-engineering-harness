const { openBatchWait } = require('./dry-traces.cjs');
const { setProjectState } = require('../health.cjs');
const { nextBatchAll } = require('./outcome.cjs');
const { resetToBefore } = require('./phase-merge.cjs');
const results = require('./job-results.cjs');
const { save, mark, decide, decideOnce, effect, findJob, ensureJob, isHeld, isWaiting, gitOf, gitArgs, branchOf, activeKeys } = require('./phase-kit.cjs');

const setFailures = (run, sql) =>
  run.db.prepare(`UPDATE versions SET build_failures = ${sql} WHERE project = ? AND version = ?`).run(run.project.key, run.batch.version);

function countFailure(run, reason) {
  const max = run.rules.Q03.max_build_failures;
  return mark(run, null, 'build-red', () => {
    setFailures(run, 'build_failures + 1');
    const { build_failures: failures } = run.db.prepare('SELECT build_failures FROM versions WHERE project = ? AND version = ?').get(run.project.key, run.batch.version);
    decide(run, 'Q02', 'build-red', { failures, reason });
    if (failures < max) return { failures };
    decide(run, 'Q03', 'project-paused', { failures });
    setProjectState(run.db, run.project.key, { paused: true });
    openBatchWait(run, { role: 'dev', subject: `Dừng project ${run.project.key}: ${failures} lần build hỏng liên tiếp (Q03)` });
    return { failures };
  });
}

async function buildRed(run, reason) {
  await resetToBefore(run);
  countFailure(run, reason);
  await nextBatchAll(run, activeKeys(run), { code: 'Q02', reason: `Build hỏng: ${reason}` });
  save(run, { phase: 'done', landing: false, lanes: [] });
  return true;
}

async function ensureBuild(run, suffix, distribute) {
  const known = findJob(run, 'build', `${run.batch.id}#${suffix}`);
  if (known) return known;
  if (isHeld(run)) return null;
  await gitOf(run).landing.versionWorktree(gitArgs(run, { batchId: run.batch.id, sha: run.batch.data.sha, reuse: true }));
  return ensureJob(run, { kind: 'build', suffix, payload: results.buildPayload(run, distribute) });
}

async function building(run) {
  const job = await ensureBuild(run, 'b1', false);
  if (isWaiting(job)) return false;
  const judged = await results.judgeBuildJob(run, job);
  if (judged.broken) {
    save(run, { phase: 'parked', reason: `Việc build #${job.id}: ${judged.reason}` });
    return true;
  }
  if (!judged.ok) return buildRed(run, judged.reason);
  mark(run, null, 'build-green', () => {
    setFailures(run, '0');
    decide(run, 'Q01', 'build-green', { build: judged.apk });
  });
  save(run, { phase: 'publishing', build: judged.apk });
  return true;
}

function prText(run) {
  const { version, data } = run.batch;
  const rows = data.lanes.flatMap(l => (l.keys.length || !l.title ? l.keys : [l.title]).map(key => `- ${key}: ${l.branch} (${l.commit.slice(0, 12)})`));
  return {
    title: `dz: bản ${version}`,
    body: [`PR luôn mở của bản ${version}, do dev-zone gộp các bản sửa bug đã qua review, cổng và build.`, '', 'Đợt mở PR này:', ...rows].join('\n'),
  };
}

async function pingMerge(run, pr) {
  const { landing } = gitOf(run);
  const max = run.rules.F07.max_pr_lines;
  const lines = await landing.diffLines(gitArgs(run, { base: run.project.base, sha: run.batch.data.sha }));
  if (lines <= max) return;
  mark(run, null, 'pr-large', () => {
    decide(run, 'F07', 'ping-merge', { lines, pr: pr.url });
    openBatchWait(run, { role: 'dev', subject: `Merge PR ${branchOf(run)} (quá ${max} dòng)`, link: pr.url });
  });
}

async function adopt(run, versionBranch) {
  const { landing } = gitOf(run);
  let pushed = null;
  try {
    await resetToBefore(run);
  } catch (error) {
    if (error.code !== 'PUSHED') throw error;
    pushed = error;
  }
  const adopted = await landing.adoptRemote(gitArgs(run, { versionBranch }));
  if (pushed && !adopted.ok) throw pushed;
  const published = await landing.isPublished(gitArgs(run, { versionBranch, sha: run.batch.data.sha }));
  return { ...adopted, published };
}

async function settleDiverged(run) {
  const versionBranch = branchOf(run);
  const { published, ...adopted } = await effect(run, null, 'adopt', () => adopt(run, versionBranch));
  if (published) {
    save(run, { diverged: false, pushed: true });
    return false;
  }
  mark(run, null, 'diverged', () => {
    decide(run, 'F04', 'branch-moved', { before: run.batch.data.before, ...adopted });
    if (!adopted.ok) openBatchWait(run, { role: 'dev', subject: `Nhánh ${versionBranch} trên GitHub không còn chứa commit đã kiểm, cần dev gỡ tay` });
  });
  await nextBatchAll(run, activeKeys(run), { code: 'F04', reason: `Nhánh ${versionBranch} trên GitHub đã có commit khác` });
  save(run, { phase: 'done', landing: false, lanes: [] });
  return true;
}

async function push(run, versionBranch, sha) {
  try {
    await effect(run, null, 'push', () => gitOf(run).merge.pushVersion(gitArgs(run, { versionBranch, sha })));
  } catch (error) {
    if (error.code !== 'DIVERGED') throw error;
    save(run, { diverged: true });
  }
}

async function publishing(run) {
  const { merge } = gitOf(run);
  const { sha } = run.batch.data;
  const versionBranch = branchOf(run);
  if (!run.batch.data.diverged && !run.batch.data.pushed) await push(run, versionBranch, sha);
  if (run.batch.data.diverged && (await settleDiverged(run))) return true;
  if (!run.batch.data.pushed) save(run, { pushed: true });
  const pr = await effect(run, null, 'pr', () => merge.ensurePr(gitArgs(run, { versionBranch, ...prText(run), gh: run.ctx.bugs.gh })));
  await pingMerge(run, pr);
  decideOnce(run, null, 'published', 'F03', 'published', { sha, pr: pr.url });
  save(run, { phase: 'distributing', pr });
  return true;
}

module.exports = { ensureBuild, building, publishing, prText };
