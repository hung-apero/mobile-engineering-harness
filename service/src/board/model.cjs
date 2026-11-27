const store = require('../specs/store.cjs');
const bugsStore = require('../bugs/store.cjs');
const jobs = require('../jobs.cjs');
const { loadProjects } = require('../projects.cjs');
const { loadQuota } = require('../quota.cjs');
const { intakeState } = require('../intake-state.cjs');
const { quotaLine, attempt } = require('../status.cjs');
const { capacity, isCommandKind } = require('../slots.cjs');
const { SPEC_LABELS } = require('../web/spec-labels.cjs');
const { activityOf } = require('./activity.cjs');
const { bugBoard } = require('./bug-groups.cjs');
const { productsOf } = require('./spec-products.cjs');
const { specDetail, specSummary } = require('./spec-detail.cjs');

const INACTIVE = ['done', 'landed-dry', 'cancelled'];
const ROLES = { po: 'PO', qa: 'QA', dev: 'dev' };

function waitingRoles(db) {
  const rows = db.prepare("SELECT k.key, w.role FROM kv k JOIN waits w ON w.id = CAST(k.value AS INTEGER) WHERE k.key LIKE 'spec-wait:%' AND w.state = 'open' ORDER BY w.id").all();
  const roles = new Map();
  for (const row of rows) {
    const id = Number(row.key.split(':')[1]);
    if (!roles.has(id)) roles.set(id, ROLES[row.role] ?? row.role);
  }
  return roles;
}

const cardOf = detail => ({ summary: specSummary(detail), links: detail.links });

function specsOf(ctx, project, roles, now) {
  const { db } = ctx;
  return store.listSpecs(db, { project })
    .filter(spec => !INACTIVE.includes(spec.state))
    .map(spec => ({
      id: spec.id, title: spec.title || `Spec #${spec.id}`, state: spec.state, label: SPEC_LABELS[spec.state] ?? spec.state,
      waitingFor: roles.get(spec.id) ?? null, products: productsOf(spec, now), ...cardOf(specDetail(ctx, project, spec.id, now)),
    }));
}

function slotsOf(ctx, now) {
  const running = jobs.listJobs(ctx.db, { states: ['starting', 'running'] }).filter(job => !isCommandKind(job.kind));
  return { used: running.reduce((sum, job) => sum + job.slotsGranted, 0), total: capacity(now, ctx.rulesFor().limits) };
}

function batchesOf(db, project) {
  return bugsStore.listBatches(db, { project, states: ['open', 'running'] })
    .map(({ id, version, state, data, keys }) => ({ id, version, state, phase: data.phase ?? null, keys }));
}

function boardModel(ctx, { keys = [] }, now) {
  const { projects } = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome });
  const shown = [...projects.values()].filter(project => project.schedulable && (keys.length === 0 || keys.includes(project.key)));
  const roles = waitingRoles(ctx.db);
  return {
    quota: attempt(() => quotaLine(loadQuota(ctx.db, now), intakeState(ctx, ctx.rulesFor().rules, now))),
    slots: attempt(() => slotsOf(ctx, now)),
    projects: shown.map(({ key }) => ({
      key,
      specs: specsOf(ctx, key, roles, now),
      bugs: bugBoard(ctx.db, key, now),
      batches: batchesOf(ctx.db, key),
      activity: activityOf(ctx.db, key, now),
    })),
  };
}

function projectBoard(ctx, viewer, key, now) {
  if (viewer.keys.length > 0 && !viewer.keys.includes(key)) return null;
  const model = boardModel(ctx, { keys: [key] }, now);
  return model.projects.length === 1 ? { ...model, project: model.projects[0] } : null;
}

module.exports = { boardModel, projectBoard };
