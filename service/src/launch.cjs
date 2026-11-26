const fs = require('node:fs');
const path = require('node:path');
const jobs = require('./jobs.cjs');
const kv = require('./kv.cjs');
const { record } = require('./decisions.cjs');
const { workerArgs, workerEnv, applyEnv } = require('./worker.cjs');
const { isCommandKind } = require('./slots.cjs');
const { contain } = require('./sandbox.cjs');
const { blockStarts, clearStartBlock } = require('./intake-state.cjs');
const { logChanged } = require('./service-log.cjs');
const { firstLine } = require('./redact.cjs');

const CONTINUE = 'Tiếp tục việc đang dở.';
const MAX_START_FAILURES = 3;
const SESSION_FLAGS = ['--', '--session-id', '--resume'];
const failuresKey = id => `start-failures:${id}`;

function decide(ctx, job, action, evidence, now) {
  const { version } = ctx.rulesFor(job.project);
  record(ctx.db, { project: job.project, jobId: job.id, code: 'X08', ruleVersion: version, evidence, action }, now);
  ctx.log(`job-${action}`, { jobId: job.id, project: job.project, ...evidence });
}

function commandOptions({ command, cwd }, job) {
  if (!command) throw new Error(`loại việc ${job.kind} phải trả về lệnh`);
  const { bin, args } = command;
  if (typeof bin !== 'string' || !bin || !Array.isArray(args)) throw new Error('lệnh phải có bin và args');
  if ([bin, ...args].join(' ').split(/\s+/).some(token => SESSION_FLAGS.includes(token))) throw new Error('lệnh không được chứa --, --session-id hay --resume');
  const script = path.basename(bin) === 'node' ? args.find(arg => !arg.startsWith('-')) : undefined;
  if (script !== undefined && !fs.existsSync(path.resolve(cwd, script))) throw new Error(`không có script ${script}`);
  return { bin, args: [...args, '--session-id', job.sessionId] };
}

function agentOptions(ctx, prepared, job, mcpConfig) {
  if (prepared.command) throw new Error(`loại việc ${job.kind} không được chạy lệnh`);
  const prompt = job.resume ? prepared.resumePrompt ?? CONTINUE : prepared.prompt;
  const resume = job.resume ? job.sessionId : undefined;
  return { bin: ctx.claudeBin, args: workerArgs({ ...prepared, mcpConfig, prompt, sessionId: job.sessionId, resume }) };
}

function workerOptions(ctx, job, project) {
  const handler = ctx.handlers[job.kind];
  if (!handler) throw new Error(`chưa có handler cho loại việc ${job.kind}`);
  const prepared = handler.prepare(job, { dzHome: ctx.dzHome, project, deps: ctx.handlerDeps });
  const { env, mcpConfig, sandbox } = contain(ctx, job, project, prepared, applyEnv(workerEnv(ctx.env, ctx.dzHome), prepared.env));
  return {
    ...(isCommandKind(job.kind) ? commandOptions(prepared, job) : agentOptions(ctx, prepared, job, mcpConfig)),
    env,
    sandbox,
    cwd: prepared.cwd,
    logFile: ctx.deps.logFileFor(job),
  };
}

function binaryMissing(ctx, job, error, now) {
  const message = firstLine(error);
  jobs.requeue(ctx.db, job.id, now, { keepSession: true });
  blockStarts(ctx.db, message, now);
  logChanged(ctx, 'claude-missing', { error: message }, 'claude-missing');
}

function startFailed(ctx, job, error, now) {
  const failures = (kv.get(ctx.db, failuresKey(job.id)) ?? 0) + 1;
  const message = firstLine(error);
  if (failures < MAX_START_FAILURES) {
    kv.set(ctx.db, failuresKey(job.id), failures, now);
    jobs.requeue(ctx.db, job.id, now, { keepSession: true });
    decide(ctx, job, 'start-failed', { error: message, failures }, now);
    return;
  }
  jobs.park(ctx.db, job.id, `Không mở được worker ${failures} lần liên tiếp: ${message}`, now);
  kv.del(ctx.db, failuresKey(job.id));
  decide(ctx, job, 'parked', { error: message, failures }, now);
}

function parkNow(ctx, job, error, now) {
  const message = firstLine(error);
  jobs.park(ctx.db, job.id, message, now);
  decide(ctx, job, 'parked', { error: message }, now);
  return 'next';
}

function launch(ctx, job, project, now) {
  let options;
  try {
    options = workerOptions(ctx, job, project);
  } catch (error) {
    return parkNow(ctx, job, error, now);
  }
  let started;
  try {
    started = ctx.startWorker(options);
  } catch (error) {
    if (error.machineWide && isCommandKind(job.kind)) return parkNow(ctx, job, error, now);
    if (error.machineWide) {
      binaryMissing(ctx, job, error, now);
      return 'stop';
    }
    startFailed(ctx, job, error, now);
    return 'skip';
  }
  try {
    jobs.markRunning(ctx.db, job.id, { ...started, sessionId: job.sessionId, logFile: options.logFile }, now);
  } catch (error) {
    ctx.log('mark-running-failed', { jobId: job.id, project: job.project, pid: started.pid, error: firstLine(error) });
    return 'skip';
  }
  kv.del(ctx.db, failuresKey(job.id));
  ctx.log('job-started', { jobId: job.id, project: job.project, kind: job.kind, attempt: job.attempt, resume: job.resume, pid: started.pid });
  if (!isCommandKind(job.kind)) {
    clearStartBlock(ctx.db);
    logChanged(ctx, 'claude-missing', null);
  }
  return 'next';
}

function startJobs(ctx, { projects, eligible, limits, now, kinds }) {
  const open = new Set(eligible);
  while (!ctx.stopping) {
    const job = jobs.claimNext(ctx.db, { projects: open, limits, now, kinds });
    if (!job) return;
    let outcome = 'skip';
    try {
      outcome = launch(ctx, job, projects.get(job.project), now);
    } catch (error) {
      ctx.log('launch-error', { jobId: job.id, project: job.project, error: firstLine(error) });
    }
    if (outcome === 'stop') return;
    if (outcome === 'skip') open.delete(job.project);
  }
}

module.exports = { startJobs, failuresKey };
