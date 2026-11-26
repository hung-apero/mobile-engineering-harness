const path = require('node:path');
const gate = require('../handlers/gate.cjs');
const build = require('../handlers/build.cjs');
const { firstLine } = require('../redact.cjs');
const { parseResult, parseReview, lastResultText } = require('./result.cjs');
const { gitOf, gitArgs, branchOf } = require('./phase-kit.cjs');

function base(run) {
  const { id: batchId, version, data } = run.batch;
  const branch = branchOf(run);
  return { batchId, version, startSha: data.startSha, ...(branch !== `dz/release-${version}` && { branch }) };
}

const handlerArgs = run => ({ dzHome: run.ctx.dzHome, project: run.project });
const gateTree = run => path.join(gitOf(run).landing.batchDir(gitArgs(run, { batchId: run.batch.id })), 'gate');

function bugPayload(run) {
  const { todo, round, repo, notes } = run.batch.data;
  return { ...base(run), keys: todo, round, repo, notes };
}

function reviewPayload(run, lanes, repo) {
  const { seen } = run.batch.data;
  const tickets = lanes.flatMap(lane => lane.keys.map(key => ({
    key, summary: String(seen[key]?.summary ?? ''), ...(lane.info[key]?.specRef && { specRef: lane.info[key].specRef }),
  })));
  return { ...base(run), repo, lanes: lanes.map(({ branch, commit, keys }) => ({ branch, commit, keys })), tickets };
}

const gatePayload = (run, worktree, changedFiles) => ({ batchId: run.batch.id, worktree, sha: run.batch.data.sha, changedFiles });
const buildPayload = (run, distribute) => ({ batchId: run.batch.id, worktree: gateTree(run), sha: run.batch.data.sha, distribute });

function readLog(job, read) {
  try {
    const last = lastResultText(job.logFile);
    return last ? read(last) : { ok: false, error: 'log không có kết quả' };
  } catch (error) {
    return { ok: false, error: firstLine(error) };
  }
}

const parseBugJob = (run, job) => readLog(job, last => parseResult(last.text, { allowedKeys: run.batch.data.todo, batchId: run.batch.id }));

function parseReviewJob(job, lanes) {
  const expected = lanes.map(({ branch, keys }) => ({ branch, keys }));
  return readLog(job, last => parseReview(last.structuredOutput ?? last.text, { lanes: expected }));
}

const stepFailed = job => job.state === 'failed' && job.result?.error === 'step_failed';
const usable = job => job.state === 'done' || stepFailed(job);
const brokenReason = job => job.parkReason ?? job.result?.error ?? 'việc không có kết quả';

const settle = judged => (!judged.ok && !judged.failedStep ? { broken: true, reason: judged.reason } : judged);

function judgeGateJob(run, job) {
  if (!usable(job)) return { broken: true, reason: brokenReason(job) };
  return settle(gate.judgeGate(job.result, job.payload.changedFiles, { dir: gate.gateDir(job.payload, handlerArgs(run)) }));
}

async function judgeBuildJob(run, job) {
  if (!usable(job)) return { broken: true, reason: brokenReason(job) };
  const { worktree, sha, distribute } = job.payload;
  return settle(await build.judgeBuild(job.result, { worktree, sha, apkGlob: run.project.commands.apkGlob, distribute }));
}

module.exports = { bugPayload, reviewPayload, gatePayload, buildPayload, parseBugJob, parseReviewJob, judgeGateJob, judgeBuildJob };
