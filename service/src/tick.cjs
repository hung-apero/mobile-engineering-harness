const path = require('node:path');
const { loadProjects } = require('./projects.cjs');
const { supervise } = require('./supervisor.cjs');
const { record } = require('./decisions.cjs');
const { isPaused } = require('./health.cjs');
const { observeQuota } = require('./quota.cjs');
const { intakeState } = require('./intake-state.cjs');
const { syncParked, trackBlock, trackSandbox, closeInactiveBlocks } = require('./blocks.cjs');
const { startJobs } = require('./launch.cjs');
const { refuses, pruneRuns } = require('./sandbox.cjs');
const { syncIntakeWaits } = require('./intake-waits.cjs');
const { COMMAND_KINDS } = require('./slots.cjs');
const { notify } = require('./notify.cjs');
const { pruneLogs } = require('./log-prune.cjs');
const { logChanged, logRepeated } = require('./service-log.cjs');
const { redact, firstLine } = require('./redact.cjs');
const { bugStep } = require('./bugs/step.cjs');
const { specStep } = require('./specs/step.cjs');
const { boardStep } = require('./board/sync.cjs');

const SLEEP_GAP_MS = 2 * 60 * 1000;
const COMMAND_HOLDERS = ['X01', 'X08'];
const NOISY = new Set(['stop-failed', 'probe-failed', 'error']);

async function step(ctx, name, fn) {
  try {
    const result = await fn();
    logChanged(ctx, `step:${name}`, null);
    return result;
  } catch (error) {
    const stack = redact(error?.stack ?? '').split('\n').slice(1, 5);
    logChanged(ctx, `step:${name}`, { step: name, error: firstLine(error), stack }, 'step-error');
    return undefined;
  }
}

function loadConfig(ctx) {
  const config = { projects: new Map(), projectsOk: false, base: null, isInactive: () => false };
  try {
    const { projects, errors } = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome });
    config.projects = projects;
    config.projectsOk = true;
    const broken = new Set(errors.map(e => path.basename(e.file, '.yaml')));
    config.isInactive = key => !broken.has(key) && projects.get(key)?.schedulable !== true;
    const found = errors.map(e => ({ file: e.file, error: firstLine(e) }));
    logChanged(ctx, 'projects', found.length ? { errors: found } : null, 'project-config');
  } catch (error) {
    logChanged(ctx, 'projects', { error: firstLine(error) }, 'project-config');
  }
  try {
    config.base = ctx.rulesFor();
  } catch {}
  const bad = ctx.ruleStore.lastError();
  logChanged(ctx, 'rules', bad ? { file: bad.file, error: firstLine(bad) } : null, 'rules');
  return config;
}

function versionFor(ctx, project) {
  try {
    return ctx.rulesFor(project).version;
  } catch {
    return 'không rõ';
  }
}

function repeated(ctx, action) {
  if (action.type !== 'stop-failed') return false;
  const last = ctx.db.prepare('SELECT action FROM decisions WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(action.jobId);
  return last?.action === 'stop-failed';
}

function recordAction(ctx, { jobId, project, type, code, ...evidence }, now) {
  const fields = { jobId, project, type, code, ...evidence };
  if (NOISY.has(type)) logRepeated(ctx, `${jobId}:${type}:${evidence.error ?? ''}`, fields, 'supervise', now);
  else ctx.log('supervise', fields);
  if (code === null || repeated(ctx, { jobId, type })) return;
  record(ctx.db, { project, jobId, code, ruleVersion: versionFor(ctx, project), evidence, action: type }, now);
}

async function superviseStep(ctx, now) {
  const { actions, quotas } = await supervise(ctx.db, { rulesFor: ctx.rulesFor, deps: ctx.deps, now, boot: ctx.boot, wakeAt: ctx.wakeAt });
  ctx.boot = false;
  for (const observation of quotas) observeQuota(ctx.db, observation);
  for (const action of actions) await step(ctx, 'decision', () => recordAction(ctx, action, now));
  return true;
}

function eligibleProjects(ctx, projects, now) {
  const eligible = new Set();
  for (const project of projects.values()) {
    try {
      if (!project.schedulable) continue;
      const blocked = trackBlock(ctx.db, project.key, ctx.rulesFor(project.key), now);
      const refused = trackSandbox(ctx.db, project.key, refuses(ctx, project), now);
      if (!blocked && !refused && !isPaused(ctx.db, project.key)) eligible.add(project.key);
      logChanged(ctx, `project:${project.key}`, null);
    } catch (error) {
      logChanged(ctx, `project:${project.key}`, { project: project.key, error: firstLine(error) }, 'project-error');
    }
  }
  return eligible;
}

function claimStep(ctx, { projects, base }, now) {
  const eligible = eligibleProjects(ctx, projects, now);
  const state = intakeState(ctx, base.rules, now);
  if (state.open) startJobs(ctx, { projects, eligible, limits: base.limits, now });
  else if (COMMAND_HOLDERS.includes(state.code) && !state.lowDisk) startJobs(ctx, { projects, eligible, limits: base.limits, now, kinds: COMMAND_KINDS });
  const { open, code, until } = state.open ? intakeState(ctx, base.rules, now) : state;
  syncIntakeWaits(ctx, projects, { open, code }, now);
  logChanged(ctx, 'intake', { open, code, until: code === 'X08' ? undefined : until }, 'intake');
}

function noticeSleep(ctx, now) {
  if (ctx.lastTickAt !== null && now - ctx.lastTickAt > SLEEP_GAP_MS) ctx.wakeAt = now;
  ctx.lastTickAt = now;
}

async function tick(ctx, now) {
  noticeSleep(ctx, now);
  const config = loadConfig(ctx);
  const supervised = await step(ctx, 'supervise', () => superviseStep(ctx, now));
  if (supervised && config.base) await step(ctx, 'claim', () => claimStep(ctx, config, now));
  if (supervised && config.base) bugStep(ctx, config, now);
  if (supervised && config.base) specStep(ctx, config, now);
  if (supervised && config.base) boardStep(ctx, config, now);
  if (config.projectsOk && ctx.desk) ctx.deskStepPending = Promise.resolve(ctx.desk.step(config.projects.values(), now)).catch(error => ctx.log('desk-error', { error: firstLine(error) }));
  await step(ctx, 'waits', () => {
    closeInactiveBlocks(ctx.db, config.isInactive, now);
    syncParked(ctx.db, now, config.isInactive);
  });
  await step(ctx, 'runs', () => pruneRuns(ctx));
  await step(ctx, 'prune', () => pruneLogs(ctx, now));
  await step(ctx, 'notify', () => notify(ctx, config.projects, now));
}

module.exports = { tick };
