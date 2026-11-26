const store = require('../specs/store.cjs');
const bugsStore = require('../bugs/store.cjs');
const jobs = require('../jobs.cjs');
const { progressOf } = require('../specs/build-result.cjs');
const { loadProjects } = require('../projects.cjs');
const { loadQuota } = require('../quota.cjs');
const { intakeState } = require('../intake-state.cjs');
const { quotaLine, attempt } = require('../status.cjs');
const { capacity, isCommandKind } = require('../slots.cjs');
const { SPEC_LABELS } = require('../web/spec-labels.cjs');
const { activityOf } = require('./activity.cjs');
const { bugBoard } = require('./bug-groups.cjs');

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const FINISHED = ['done', 'landed-dry'];
const BUILT = new Set(['building', 'smoking', 'uidiff', 'reviewing', 'candidate', 'po-trial', 'landing']);
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

function progress(spec) {
  if (!BUILT.has(spec.state) || typeof spec.data?.repo !== 'string') return null;
  try {
    const found = progressOf(spec.data.repo);
    return found.total ? found : null;
  } catch {
    return null;
  }
}

function specsOf(db, project, roles, now) {
  return store.listSpecs(db, { project })
    .filter(spec => spec.state !== 'cancelled' && (!FINISHED.includes(spec.state) || now - spec.updatedAt <= RECENT_MS))
    .map(spec => ({ id: spec.id, title: spec.title, state: spec.state, label: SPEC_LABELS[spec.state] ?? spec.state, waitingFor: roles.get(spec.id) ?? null, progress: progress(spec) }));
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
      specs: specsOf(ctx.db, key, roles, now),
      bugs: bugBoard(ctx.db, key, now),
      batches: batchesOf(ctx.db, key),
      activity: activityOf(ctx.db, key, now),
    })),
  };
}

module.exports = { boardModel };
