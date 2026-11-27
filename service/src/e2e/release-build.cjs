const jobs = require('../jobs.cjs');
const store = require('../bugs/store.cjs');
const { judgeBuild } = require('../handlers/build.cjs');
const { firstLine } = require('../redact.cjs');
const { keepBuild } = require('./builds.cjs');
const { save, decide, setWait } = require('./state.cjs');

const RETRY_MS = 60 * 60 * 1000;
const MAX_FAILURES = 2;
const WAITING = ['queued', 'starting', 'running', 'parked'];
const batchOf = version => `release-${version.replace(/[^A-Za-z0-9]/g, '-')}`.slice(0, 40);
const gitArgs = (ctx, project) => ({ dzHome: ctx.dzHome, project });

function mayBuild(ctx, project, name, state, tree, now) {
  if (state.build?.jobId) return false;
  if (store.listBatches(ctx.db, { project: project.key, version: name, states: ['running'] }).length) return false;
  if (state.build?.tree !== tree) return true;
  return state.build.failures < MAX_FAILURES && now >= state.build.until;
}

async function queueReleaseBuild(ctx, project, name, state, { sha, tree }, now) {
  if (!mayBuild(ctx, project, name, state, tree, now)) return false;
  const batchId = batchOf(name);
  const { tree: worktree } = await ctx.bugs.git.landing.versionWorktree({ ...gitArgs(ctx, project), batchId, sha, reuse: true });
  const failures = state.build?.tree === tree ? state.build.failures : 0;
  const payload = { batchId, worktree, sha, distribute: false };
  const { id } = jobs.enqueue(ctx.db, { project: project.key, kind: 'build', key: `${batchId}#${sha}`, priority: 1, slots: 1, payload }, now);
  state.build = { jobId: id, sha, tree, failures, until: 0 };
  save(ctx.db, project.key, name, state, now);
  decide(ctx, project, 'R01', 'release-build-queued', { version: name, sha, tree }, now);
  return true;
}

async function judged(project, job) {
  if (!job) return { ok: false, reason: 'mất việc build' };
  if (job.state !== 'done' && job.result?.error !== 'step_failed') return { ok: false, reason: job.parkReason ?? job.result?.error ?? 'việc build không có kết quả' };
  const { worktree, sha } = job.payload;
  return judgeBuild(job.result, { worktree, sha, apkGlob: project.commands.apkGlob });
}

async function keep(ctx, project, name, state, apk, now) {
  const { jobId, sha } = state.build;
  await keepBuild({ db: ctx.db, dzHome: ctx.dzHome, project, version: name, batchId: `release-${jobId}`, sha, build: apk, now });
  decide(ctx, project, 'R01', 'release-build-kept', { version: name, sha, tree: state.build.tree }, now);
  state.build = null;
  setWait(ctx, project, state, 'build', false, {}, now);
}

function noteFailure(ctx, project, name, state, reason, now) {
  const failures = state.build.failures + 1;
  decide(ctx, project, 'R01', 'release-build-failed', { version: name, sha: state.build.sha, failures, reason: firstLine(reason) }, now);
  state.build = { ...state.build, jobId: null, failures, until: now + RETRY_MS };
  if (failures < MAX_FAILURES || store.getVersion(ctx.db, project.key, name)?.state !== 'open') return;
  setWait(ctx, project, state, 'build', true, { role: 'dev', subject: `Bản ${name}: build cây sẽ phát hành ${state.build.sha.slice(0, 12)} hỏng ${failures} lần: ${firstLine(reason)}` }, now);
}

async function settleReleaseBuild(ctx, project, name, state, now) {
  const job = jobs.getJob(ctx.db, state.build.jobId);
  if (job && WAITING.includes(job.state)) return false;
  const result = await judged(project, job);
  if (result.ok) await keep(ctx, project, name, state, result.apk, now);
  else noteFailure(ctx, project, name, state, result.reason, now);
  save(ctx.db, project.key, name, state, now);
  return result.ok;
}

module.exports = { queueReleaseBuild, settleReleaseBuild, batchOf };
