const kv = require('../kv.cjs');
const { isPaused, projectBlocked } = require('../health.cjs');
const { intakeState } = require('../intake-state.cjs');
const { openWait, resolveWait } = require('../pings.cjs');
const { record } = require('../decisions.cjs');
const { logChanged } = require('../service-log.cjs');
const { firstLine } = require('../redact.cjs');
const store = require('./store.cjs');
const polling = require('./polling.cjs');
const { intake, planBatches } = require('./intake.cjs');
const { toIssue, loadIssue } = require('./issue-view.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { checkRelease } = require('./release.cjs');
const { fixVersionNames } = require('./fix-versions.cjs');
const { closeStaleWaits } = require('./wait-close.cjs');
const { guard } = require('./guard.cjs');
const { parkRequested } = require('./park-request.cjs');
const { takes } = require('./defer.cjs');
const { watchBase } = require('./base-watch.cjs');
const { readReviews, attachNotes, answerNotes } = require('./pr-review.cjs');
const { settleRuns, startE2e } = require('../e2e/step.cjs');

const MINUTE = 60 * 1000;
const BACKOFF_MINUTES = [3, 6, 12, 15];
const GIVE_UP_MS = 30 * MINUTE;
const MAX_PASSES = 5;

const backoffKey = project => `bug-jira:${project}`;
const onlyKey = (project, version) => `bug-only:${project}:${version}`;

function log(ctx, project, code, action, evidence, now) {
  record(ctx.db, { project, code, ruleVersion: ruleVersionOf(ctx, project), evidence, action }, now);
}

async function pollVersion(ctx, project, version, now) {
  const { rules, limits } = ctx.rulesFor(project.key);
  const only = kv.get(ctx.db, onlyKey(project.key, version.version));
  const jira = await ctx.bugs.jira(project);
  const text = polling.jql(project.key, version.version, now, { waiting: project.jiraStatus.waiting, baselineAt: version.baselineAt ?? now, keys: only?.length ? only : undefined, fixVersions: await fixVersionNames(ctx, project, jira, version.version, now) });
  const hits = (await jira.search(text)).filter(hit => (!only?.length || only.includes(hit.key)) && takes(ctx, project, version, hit));
  const issues = [];
  for (const hit of hits) {
    const state = store.getTicket(ctx.db, project.key, hit.key)?.state;
    issues.push(['accepted', 'batched', 'dev'].includes(state) ? toIssue(hit) : await loadIssue(jira, hit.key));
  }
  const result = intake(ctx.db, { project: project.key, version: version.version, issues, now, inProgress: project.jiraStatus.inProgress, reopenLimit: rules.B09.reopen_limit });
  polling.recordPoll(ctx.db, project.key, version.version, { newCount: result.accepted.length, now });
  noteIntake(ctx, project, result, now);
  planBatches(ctx.db, project.key, now, limits.batch);
  return result;
}

function noteIntake(ctx, project, result, now) {
  for (const key of result.giveDev) {
    log(ctx, project.key, 'B09', 'give-dev', { key }, now);
    openWait(ctx.db, { project: project.key, role: 'dev', subject: `Ticket ${key} đã reopen quá giới hạn, cần dev xử lý (B09)` }, now);
  }
  for (const skip of result.skipped.filter(s => !result.giveDev.includes(s.key))) {
    const seen = `bug-skip:${project.key}:${skip.key}`;
    if (kv.get(ctx.db, seen) === skip.code) continue;
    kv.set(ctx.db, seen, skip.code, now);
    log(ctx, project.key, skip.code, 'skip', { key: skip.key, reason: skip.reason }, now);
  }
}

function noteFailure(ctx, project, error, now) {
  const previous = kv.get(ctx.db, backoffKey(project.key)) ?? { failures: 0, firstAt: now, waitId: null };
  const failures = previous.failures + 1;
  const until = now + BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1] * MINUTE;
  let { waitId } = previous;
  if (waitId === null && now - previous.firstAt >= GIVE_UP_MS) {
    waitId = openWait(ctx.db, { project: project.key, role: 'dev', subject: `Jira lỗi quá 30 phút, polling bug ${project.key} bị giãn nhịp (X06)` }, now);
  }
  kv.set(ctx.db, backoffKey(project.key), { failures, firstAt: previous.firstAt, until, waitId }, now);
  log(ctx, project.key, 'X06', 'jira-backoff', { failures, retryAt: until, error: firstLine(error) }, now);
}

function noteSuccess(ctx, project, now) {
  const state = kv.get(ctx.db, backoffKey(project.key));
  if (!state) return;
  if (state.waitId !== null) resolveWait(ctx.db, state.waitId, now);
  kv.del(ctx.db, backoffKey(project.key));
  log(ctx, project.key, 'X06', 'jira-recovered', { failures: state.failures }, now);
}

const waitingForJira = (ctx, project, now) => now < (kv.get(ctx.db, backoffKey(project.key))?.until ?? 0);

function pollDue(ctx, project, version, now) {
  const { rules } = ctx.rulesFor(project.key);
  const interval = polling.pollInterval(version, now, rules.Q06.quiet_hours);
  if (interval === null || waitingForJira(ctx, project, now)) return false;
  return version.lastPollAt === null || now - version.lastPollAt >= interval;
}

async function pollDueVersions(ctx, project, versions, now) {
  for (const version of versions) {
    if (ctx.stopping || !pollDue(ctx, project, version, now)) continue;
    try {
      await pollVersion(ctx, project, version, now);
      noteSuccess(ctx, project, now);
    } catch (error) {
      noteFailure(ctx, project, error, now);
      return;
    }
  }
}

async function advanceBatch(ctx, project, id, now) {
  const { rules, limits } = ctx.rulesFor(project.key);
  for (let pass = 0; pass < MAX_PASSES && !ctx.stopping; pass++) {
    const found = store.getBatch(ctx.db, id);
    if (!found || store.FINISHED.includes(found.state)) break;
    const batch = attachNotes(ctx, found, now);
    const result = await ctx.bugs.advanceBatch(ctx, { project, rules, limits, batch, now });
    if (!result?.changed) break;
  }
  const last = store.getBatch(ctx.db, id);
  if (last?.state === 'done') await guard(ctx, project, 'pr-reply', () => answerNotes(ctx, project, last, now));
  return last?.state === 'done';
}

function mayClaim(ctx, project, now) {
  if (isPaused(ctx.db, project.key)) return false;
  return intakeState(ctx, ctx.rulesFor().rules, now).open;
}

async function advanceVersion(ctx, project, version, now) {
  let delivered = false;
  const claimable = mayClaim(ctx, project, now);
  for (const batch of store.listBatches(ctx.db, { project: project.key, version: version.version, states: ['open', 'running'] })) {
    if (ctx.stopping) break;
    if (batch.state === 'open' && !claimable && !parkRequested(ctx.db, batch.id)) continue;
    delivered = (await advanceBatch(ctx, project, batch.id, now)) || delivered;
  }
  return delivered;
}

async function checkReleases(ctx, project, version, now, force) {
  if (!version.polling || waitingForJira(ctx, project, now)) return;
  const assessed = await guard(ctx, project, `release:${version.version}`, () => checkRelease(ctx, project, version, now, { force }));
  if (!assessed) return;
  await guard(ctx, project, `e2e:${version.version}`, () => startE2e(ctx, project, version, assessed, now));
  await guard(ctx, project, `base:${version.version}`, () => watchBase(ctx, project, version, now));
  await guard(ctx, project, `pr-review:${version.version}`, () => readReviews(ctx, project, version, now));
}

async function parkOnly(ctx, project, now) {
  for (const batch of store.listBatches(ctx.db, { project: project.key, states: ['open', 'running'] })) {
    if (!ctx.stopping && parkRequested(ctx.db, batch.id)) await advanceBatch(ctx, project, batch.id, now);
  }
}

async function projectStep(ctx, project, now) {
  const { rules } = ctx.rulesFor(project.key);
  const settled = (await guard(ctx, project, 'e2e', () => settleRuns(ctx, project, now))) ?? [];
  if (projectBlocked(ctx.db, project.key, rules)) return parkOnly(ctx, project, now);
  const open = () => store.listVersions(ctx.db, project.key).filter(version => version.state === 'open');
  if (!isPaused(ctx.db, project.key)) {
    await pollDueVersions(ctx, project, open(), now);
    planBatches(ctx.db, project.key, now, ctx.rulesFor(project.key).limits.batch);
  }
  if (!waitingForJira(ctx, project, now)) await guard(ctx, project, 'wait-close', () => closeStaleWaits(ctx, project, open(), now));
  for (const version of open()) {
    if (ctx.stopping) return;
    const delivered = await advanceVersion(ctx, project, version, now);
    await checkReleases(ctx, project, store.getVersion(ctx.db, project.key, version.version), now, delivered || settled.includes(version.version));
  }
}

async function runStep(ctx, config, now) {
  const projects = [...config.projects.values()].filter(project => project.schedulable);
  await Promise.all(projects.map(async project => {
    try {
      await projectStep(ctx, project, now);
      logChanged(ctx, `bugs:${project.key}`, null);
    } catch (error) {
      logChanged(ctx, `bugs:${project.key}`, { project: project.key, error: firstLine(error) }, 'bug-step-error');
    }
  }));
}

function bugStep(ctx, config, now) {
  if (ctx.bugStepPending) return ctx.bugStepPending;
  const pending = runStep(ctx, config, now)
    .catch(error => logChanged(ctx, 'bugs', { error: firstLine(error) }, 'bug-step-error'))
    .finally(() => {
      ctx.bugStepPending = null;
    });
  ctx.bugStepPending = pending;
  return pending;
}

module.exports = { bugStep, pollVersion, backoffKey, onlyKey };
