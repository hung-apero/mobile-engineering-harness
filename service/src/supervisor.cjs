const fs = require('node:fs');
const path = require('node:path');
const jobs = require('./jobs.cjs');
const worker = require('./worker.cjs');
const { isCommandKind } = require('./slots.cjs');
const { bootTime } = require('./boot-time.cjs');
const { readEvents, summarize } = require('./stream-reader.cjs');
const { judgeDead, canResume, silentSince, isSilent, mergeSummary, newestQuota } = require('./verdict.cjs');

const STOP_GRACE_MS = 10000;
const START_GRACE_MS = 60000;
const WATCHED = ['starting', 'running'];

function defaultDeps(dzHome) {
  return {
    readEvents,
    summarize,
    isSameProcess: worker.isSameProcess,
    stopWorker: worker.stopWorker,
    findWorkerBySession: worker.findWorkerBySession,
    bootTime,
    modifiedAt: file => fs.statSync(file).mtimeMs,
    logFileFor: job => path.join(dzHome, 'logs', `${job.id}-${job.attempt}-${String(job.sessionId).slice(0, 8)}.jsonl`),
  };
}

function act(job, type, code, evidence = {}) {
  return { jobId: job.id, project: job.project, type, code, ...evidence };
}

function scan(deps, file, from) {
  let summary = deps.summarize([]);
  let offset = from;
  let moved = false;
  for (;;) {
    const read = deps.readEvents(file, offset);
    if (read.truncated ? read.offset === 0 : read.offset <= offset) return { summary, offset, moved };
    summary = mergeSummary(summary, deps.summarize(read.events));
    if (read.missingSession) summary.missingSession = true;
    offset = read.offset;
    moved = true;
  }
}

function stillCurrent(db, job) {
  const row = jobs.getJob(db, job.id);
  return row && row.state === job.state && row.attempt === job.attempt ? row : null;
}

function superviseStarting(ctx, job) {
  const { db, deps, now, boot } = ctx;
  let found;
  try {
    found = deps.findWorkerBySession(job.sessionId);
  } catch (error) {
    return act(job, 'probe-failed', null, { error: error.message });
  }
  if (found) {
    jobs.markRunning(db, job.id, { pid: found.pid, pidStart: found.pidStart, sessionId: job.sessionId, logFile: deps.logFileFor(job) }, now);
    return act(job, 'adopted', 'X04', { pid: found.pid });
  }
  if (!boot && now - job.startedAt <= START_GRACE_MS) return null;
  const file = deps.logFileFor(job);
  const log = scan(deps, file, 0);
  if (log.moved) return settleDead(ctx, job, log, file);
  jobs.requeue(db, job.id, now, { keepSession: true });
  return act(job, 'requeued', 'X04', { attempt: job.attempt });
}

function observedAt({ deps, now }, file) {
  try {
    return Math.min(now, deps.modifiedAt(file));
  } catch {
    return now;
  }
}

function settleDead(ctx, job, { summary }, file) {
  const { db, deps, now, rulesFor, quotas } = ctx;
  if (summary.quota) {
    const unread = job.logOffset > 0 ? scan(deps, file, job.logOffset).summary.quota : summary.quota;
    quotas.push(unread ? { quota: unread, at: observedAt(ctx, file) } : { quota: summary.quota, at: job.startedAt });
  }
  const verdict = judgeDead(summary, { command: isCommandKind(job.kind) });
  const keepSession = canResume(summary, job);
  if (verdict.type === 'done') {
    jobs.finish(db, job.id, 'done', verdict.result, now);
    return act(job, 'done', verdict.code, { costUsd: verdict.result.costUsd, turns: verdict.result.turns });
  }
  if (verdict.type === 'failed') {
    jobs.finish(db, job.id, 'failed', verdict.result, now);
    return act(job, 'failed', verdict.code, { error: verdict.result.error });
  }
  if (verdict.type === 'quota') {
    jobs.requeue(db, job.id, now, { keepSession, ran: true });
    return act(job, 'requeued', verdict.code, { quota: verdict.quota });
  }
  if (verdict.type === 'park') {
    jobs.park(db, job.id, verdict.reason, now);
    return act(job, 'parked', verdict.code, { denials: verdict.denials });
  }
  if (job.startedAt < deps.bootTime()) {
    jobs.requeue(db, job.id, now, { keepSession, ran: true });
    return act(job, 'requeued', 'X04', { attempt: job.attempt, reboot: true, freshSession: !keepSession });
  }
  const { max_resumes: max } = rulesFor(job.project).rules.X02;
  const resumed = jobs.requeueForResume(db, job.id, now, { max, keepSession });
  if (resumed) return act(job, 'resumed', verdict.code, { error: verdict.result.error, resumes: resumed.resumes, freshSession: !keepSession });
  jobs.finish(db, job.id, 'failed', verdict.result, now);
  return act(job, 'failed', verdict.code, { error: verdict.result.error, resumes: job.resumes });
}

async function stopSafely(deps, job) {
  try {
    return { stopped: (await deps.stopWorker(job.pid, job.pidStart, STOP_GRACE_MS)) === true };
  } catch (error) {
    return { stopped: false, error: error.message };
  }
}

async function superviseLive(ctx, job) {
  const { db, deps, now, rulesFor, quotas, wakeAt } = ctx;
  const { summary, offset, moved } = scan(deps, job.logFile, job.logOffset);
  if (summary.quota) quotas.push({ quota: summary.quota, at: observedAt(ctx, job.logFile) });
  if (moved) {
    jobs.updateProgress(db, job.id, { logOffset: offset, lastEventAt: now });
    return null;
  }
  const { rules } = rulesFor(job.project);
  if (!isSilent(job, rules, now, wakeAt)) return null;
  const silentMinutes = Math.floor((now - silentSince(job, wakeAt)) / 60000);
  const { stopped, error } = await stopSafely(deps, job);
  if (!stopped) return act(job, 'stop-failed', 'X02', { pid: job.pid, silentMinutes, ...(error && { error }) });
  if (!stillCurrent(db, job)) return null;
  const keepSession = canResume(scan(deps, job.logFile, 0).summary, job);
  const resumed = jobs.requeueForResume(db, job.id, now, { max: rules.X02.max_resumes, keepSession });
  if (resumed) return act(job, 'resumed', 'X02', { silentMinutes, resumes: resumed.resumes, freshSession: !keepSession });
  jobs.park(db, job.id, `X02: im ${silentMinutes} phút, đã hết lượt chạy tiếp`, now);
  return act(job, 'parked', 'X02', { silentMinutes, resumes: job.resumes });
}

async function superviseRunning(ctx, job) {
  let alive;
  try {
    alive = ctx.deps.isSameProcess(job.pid, job.pidStart);
  } catch (error) {
    return act(job, 'probe-failed', null, { error: error.message });
  }
  return alive ? superviseLive(ctx, job) : settleDead(ctx, job, scan(ctx.deps, job.logFile, 0), job.logFile);
}

async function supervise(db, { rulesFor, deps, now, boot, wakeAt = 0 }) {
  const ctx = { db, deps, now, boot, wakeAt, rulesFor, quotas: [] };
  const actions = [];
  for (const listed of jobs.listJobs(db, { states: WATCHED })) {
    try {
      const job = stillCurrent(db, listed);
      if (!job) continue;
      const action = job.state === 'starting' ? superviseStarting(ctx, job) : await superviseRunning(ctx, job);
      if (action) actions.push(action);
    } catch (error) {
      actions.push(act(listed, 'error', null, { error: error.message }));
    }
  }
  return { actions, quota: newestQuota(ctx.quotas), quotas: ctx.quotas };
}

module.exports = { supervise, defaultDeps };
