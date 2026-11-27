const store = require('./store.cjs');
const { isPaused } = require('../health.cjs');
const { logChanged } = require('../service-log.cjs');
const { firstLine } = require('../redact.cjs');
const { createRun, openOnce, closeWaits, nameOf } = require('./kit.cjs');
const { advanceSpec, STATES, idle } = require('./machine.cjs');
const { settleChats } = require('./chats.cjs');

const MAX_PASSES = 6;
const MAX_ERRORS = 5;

function noteError(ctx, project, id, error, now) {
  const count = (ctx.specs.errors.get(id) ?? 0) + 1;
  ctx.specs.errors.set(id, count);
  if (count < MAX_ERRORS) return;
  const run = createRun(ctx, project, store.getSpec(ctx.db, id), now);
  openOnce(run, 'step-error', 'dev', `Spec ${nameOf(run.spec)} lỗi liên tục: ${firstLine(error)}`);
}

async function oneSpec(ctx, project, id, now) {
  const { busy } = ctx.specs;
  if (busy.has(id)) return;
  busy.add(id);
  try {
    for (let pass = 0; pass < MAX_PASSES && !ctx.stopping; pass++) {
      const spec = store.getSpec(ctx.db, id);
      if (!spec || !(await advanceSpec(createRun(ctx, project, spec, now)))) break;
    }
    logChanged(ctx, `spec:${id}`, null);
    ctx.specs.errors.delete(id);
    closeWaits(ctx.db, id, now, 'step-error');
  } catch (error) {
    logChanged(ctx, `spec:${id}`, { specId: id, project: project.key, error: firstLine(error) }, 'spec-step-error');
    noteError(ctx, project, id, error, now);
  } finally {
    busy.delete(id);
  }
}

async function projectStep(ctx, project, now) {
  settleChats(ctx, project, now);
  if (isPaused(ctx.db, project.key)) return;
  for (const spec of store.listSpecs(ctx.db, { project: project.key, states: STATES })) {
    if (ctx.stopping) return;
    if (!idle(spec, project, now)) await oneSpec(ctx, project, spec.id, now);
  }
}

async function runStep(ctx, config, now) {
  const projects = [...config.projects.values()].filter(project => project.schedulable);
  await Promise.all(projects.map(async project => {
    try {
      await projectStep(ctx, project, now);
      logChanged(ctx, `specs:${project.key}`, null);
    } catch (error) {
      logChanged(ctx, `specs:${project.key}`, { project: project.key, error: firstLine(error) }, 'spec-step-error');
    }
  }));
}

function specStep(ctx, config, now) {
  if (ctx.specStepPending) return ctx.specStepPending;
  const pending = runStep(ctx, config, now)
    .catch(error => logChanged(ctx, 'specs', { error: firstLine(error) }, 'spec-step-error'))
    .finally(() => {
      ctx.specStepPending = null;
    });
  ctx.specStepPending = pending;
  return pending;
}

module.exports = { specStep };
