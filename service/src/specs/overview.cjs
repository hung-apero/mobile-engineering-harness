const jobs = require('../jobs.cjs');
const store = require('./store.cjs');
const bugs = require('../bugs/store.cjs');
const { loadProjects } = require('../projects.cjs');
const { loadQuota } = require('../quota.cjs');
const { intakeState } = require('../intake-state.cjs');
const { isBuilding } = require('./build-kit.cjs');
const { countsOf, openItems } = require('./provisional.cjs');
const { projectLine, serviceLine, intakeLine, quotaLine, attempt } = require('../status.cjs');

const OPEN_JOBS = ['queued', 'starting', 'running', 'parked'];
const MAX_SPECS = 30;

function specLinks(db) {
  const rows = db.prepare("SELECT k.key, w.link FROM kv k JOIN waits w ON w.id = CAST(k.value AS INTEGER) WHERE k.key LIKE 'spec-wait:%' AND w.state = 'open' AND w.link IS NOT NULL").all();
  return new Map(rows.map(row => [Number(row.key.split(':')[1]), row.link]));
}

function overview(ctx, now) {
  const { projects } = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome });
  const active = [...projects.values()].filter(project => project.schedulable);
  const links = specLinks(ctx.db);
  const state = attempt(() => intakeState(ctx, ctx.rulesFor().rules, now));
  return {
    service: attempt(() => serviceLine(ctx)),
    intake: typeof state === 'string' ? state : intakeLine(state),
    quota: attempt(() => quotaLine(loadQuota(ctx.db, now), state)),
    projects: active.map(project => ({ key: project.key, note: attempt(() => projectLine(ctx, project)) })),
    jobs: jobs.listJobs(ctx.db, { states: OPEN_JOBS }).map(({ project, kind, key, state: at, attempt: count, parkReason }) => ({ project, kind, key, state: at, attempt: count, reason: at === 'parked' ? parkReason : null })),
    batches: active.flatMap(({ key }) => bugs.listBatches(ctx.db, { project: key, states: ['open', 'running'] })).map(({ project, version, kind, state: at, keys }) => ({ project, version, kind, state: at, keys })),
    versions: active.flatMap(({ key }) => bugs.listVersions(ctx.db, key)).filter(item => item.state !== 'closed').map(({ project, version, branch }) => ({ project, version, branch })),
    specs: store.listSpecs(ctx.db).slice(-MAX_SPECS).reverse().map(spec => ({ id: spec.id, project: spec.project, title: spec.title, state: spec.state, updatedAt: spec.updatedAt, link: links.get(spec.id) ?? null, asks: isBuilding(spec) && openItems(spec).length ? countsOf(spec) : null })),
    waits: ctx.db.prepare("SELECT project, role, subject, link, opened_at AS openedAt FROM waits WHERE state = 'open' ORDER BY id").all(),
  };
}

module.exports = { overview };
