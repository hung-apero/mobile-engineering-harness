const { openBatchWait } = require('./dry-traces.cjs');
const { ensureBuild } = require('./phase-build.cjs');
const { recordBuildSent } = require('./polling.cjs');
const { recordWould, getEffect } = require('./effects.cjs');
const { OWN_LABEL } = require('./issue-view.cjs');
const { resolvedText } = require('./comment-text.cjs');
const { finishFixed, eachKey, owned, same } = require('./outcome.cjs');
const results = require('./job-results.cjs');
const { buildDir } = require('../handlers/build.cjs');
const { stepsOf, stepLog } = require('./result-steps.cjs');
const { firebaseLink } = require('./firebase-link.cjs');
const { keepBuild } = require('../e2e/builds.cjs');
const { firstLine } = require('../redact.cjs');
const { save, mark, decide, decideOnce, effect, idOf, isWaiting, jiraOf } = require('./phase-kit.cjs');

const UNKNOWN = 'không rõ Firebase đã nhận bản cài chưa, cần người kiểm rồi gửi tay nếu thiếu';

function distributed(run, patch = {}) {
  decideOnce(run, null, 'distributed', 'Q01', 'distributed');
  save(run, { ...patch, phase: 'delivering' });
  return true;
}

function linkOf(run, job) {
  try {
    const dir = buildDir(job.payload, { dzHome: run.ctx.dzHome, project: run.project });
    return firebaseLink(stepLog(dir, stepsOf(job.result), 'distribute'));
  } catch {
    return null;
  }
}

async function distributing(run) {
  if (!run.live) {
    await effect(run, null, 'distribute', () => {
      recordWould(run.ctx, run.project, run.batch)('would', `firebase distribute ${run.batch.data.sha}`);
      return { dryRun: true };
    });
    return distributed(run);
  }
  const park = (reason, action = 'distribute-failed') => {
    decideOnce(run, null, action, 'Q04', action, { reason });
    save(run, { phase: 'parked', reason: `Gửi bản cài không được: ${reason}` });
    return true;
  };
  if (!run.project.commands?.distribute) return park('project chưa cấu hình commands.distribute');
  const job = await ensureBuild(run, 'd1', true);
  if (isWaiting(job)) return false;
  const judged = await results.judgeBuildJob(run, job);
  if (judged.unknown) return park(UNKNOWN, 'distribute-unknown');
  if (judged.broken || !judged.ok) return park(judged.reason);
  return distributed(run, { build: judged.apk, link: linkOf(run, job) });
}

function leftInProgress(run, key, current) {
  const { inProgress, resolved } = run.project.jiraStatus;
  if (same(current, inProgress)) return false;
  return !(same(current, resolved) && getEffect(run.db, idOf(run, key, 'resolve')));
}

async function resolveTicket(run, jira, key, lane) {
  const { resolved } = run.project.jiraStatus;
  const { pr, build, link } = run.batch.data;
  const text = resolvedText({ ...lane.info[key], prUrl: pr?.url, commit: lane.commit, build, link, distributed: run.live });
  await effect(run, key, 'comment-resolved', () => jira.comment(key, `dz:${run.batch.id}:${key}:resolved`, text));
  await effect(run, key, 'unlabel', () => jira.removeLabels(key, [OWN_LABEL]));
  if (run.live) {
    const current = (await jira.issue(key)).status?.name;
    if (leftInProgress(run, key, current)) {
      decideOnce(run, key, 'left', 'X08', 'not-in-progress', { status: current });
      return;
    }
    const reachable = same(current, resolved) || (await jira.transitions(key)).some(t => same(t.to_status, resolved) || same(t.name, resolved));
    if (!reachable) {
      mark(run, key, 'no-resolve', () => {
        decide(run, 'X08', 'no-transition', { key, from: current, to: resolved });
        openBatchWait(run, { role: 'dev', subject: `${key}: đã sửa nhưng Jira không cho chuyển ${resolved}, cần chuyển tay` });
      });
      return;
    }
  }
  await effect(run, key, 'resolve', () => jira.transition(key, resolved));
}

async function keepForE2e(run) {
  const { ctx, db, project, batch, now } = run;
  const { build, sha } = batch.data;
  if (!build) return;
  try {
    await keepBuild({ db, dzHome: ctx.dzHome, project, version: batch.version, batchId: batch.id, sha, build, now });
  } catch (error) {
    decideOnce(run, null, 'keep-build', 'X08', 'keep-build-failed', { error: firstLine(error) });
  }
}

async function delivering(run) {
  const jira = await jiraOf(run);
  const { version } = run.batch;
  const { lanes } = run.batch.data;
  await eachKey(run, lanes.flatMap(l => l.keys), async key => {
    if (!owned(run, key)) return;
    await resolveTicket(run, jira, key, lanes.find(l => l.keys.includes(key)));
    await finishFixed(run, key);
  });
  recordBuildSent(run.db, run.project.key, version, run.now);
  await keepForE2e(run);
  mark(run, null, 'qa-wait', () => {
    decide(run, 'P02', 'ask-qa', { version });
    openBatchWait(run, { role: 'qa', subject: `Kiểm bản cài ${run.project.key} ${version}`, link: run.batch.data.pr?.url ?? null });
  });
  save(run, { phase: 'done', landing: false, delivered: true });
  return true;
}

module.exports = { distributing, delivering };
