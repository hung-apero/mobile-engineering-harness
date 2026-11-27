const store = require('./store.cjs');
const jobs = require('../jobs.cjs');
const kv = require('../kv.cjs');
const { isPaused } = require('../health.cjs');
const { record } = require('../decisions.cjs');
const { once, markOnce, effectId, recordWould, ruleVersionOf } = require('./effects.cjs');

const LANDING = ['merging', 'gating', 'building', 'publishing', 'distributing', 'delivering'];

function createRun(ctx, { project, rules, limits, batch, now }) {
  const live = project.live === true;
  return { ctx, db: ctx.db, project, rules, limits, batch, now, live, ruleVersion: ruleVersionOf(ctx, project.key) };
}

function save(run, patch) {
  const data = { ...run.batch.data, ...patch };
  const next = store.transitionBatch(run.db, run.batch.id, 'running', 'running', run.now, data);
  if (!next) throw new Error(`đợt ${run.batch.id} không còn chạy`);
  run.batch = next;
}

const decisionOf = (run, code, action, evidence) => ({
  project: run.project.key, code, ruleVersion: run.ruleVersion, action, evidence: { batchId: run.batch.id, ...evidence },
});

function decide(run, code, action, evidence = {}) {
  record(run.db, decisionOf(run, code, action, evidence), run.now);
}

const idOf = (run, key, step) => effectId(run.batch.id, key, step, run.live);
const effect = (run, key, step, fn) => once(run.db, idOf(run, key, step), fn, run.now);
const mark = (run, key, step, fn) => markOnce(run.db, idOf(run, key, step), fn, run.now);

function decideOnce(run, key, step, code, action, evidence = {}) {
  return mark(run, key, `decide-${step}`, () => {
    decide(run, code, action, key ? { key, ...evidence } : evidence);
  });
}

const jiraOf = run => run.ctx.bugs.jira(run.project);
const gitOf = run => run.ctx.bugs.git;

function gitArgs(run, extra = {}) {
  const { ctx, project, live, batch } = run;
  return { dzHome: ctx.dzHome, project, githubUrl: ctx.bugs.githubUrl, live, record: recordWould(ctx, project, batch), ...extra };
}

const versionRow = run => store.getVersion(run.db, run.project.key, run.batch.version);
const branchOf = run => versionRow(run)?.branch ?? `dz/release-${run.batch.version}`;

function activeKeys(run) {
  return store.listTickets(run.db, { project: run.project.key, states: ['batched'] })
    .filter(t => t.batchId === run.batch.id).map(t => t.key);
}

function findJob(run, kind, key) {
  const row = run.db.prepare('SELECT id FROM jobs WHERE project = ? AND kind = ? AND key = ? ORDER BY id DESC LIMIT 1').get(run.project.key, kind, key);
  return row ? jobs.getJob(run.db, row.id) : null;
}

function ensureJob(run, { kind, suffix, slots = 1, payload }) {
  const key = `${run.batch.id}#${suffix}`;
  const known = findJob(run, kind, key);
  if (known) return known;
  if (isHeld(run)) return null;
  const priority = run.batch.kind === 'highest' ? 0 : 1;
  const { id } = jobs.enqueue(run.db, { project: run.project.key, kind, key, priority, slots, payload }, run.now);
  return jobs.getJob(run.db, id);
}

const isHeld = run => isPaused(run.db, run.project.key);
const isWaiting = job => job === null || ['queued', 'starting', 'running'].includes(job.state);
const isBroken = job => job !== null && ['failed', 'parked'].includes(job.state);

function landingHolder(run) {
  return store.listBatches(run.db, { project: run.project.key, version: run.batch.version, states: ['open', 'running'] })
    .find(b => b.id !== run.batch.id && (LANDING.includes(b.data.phase) || b.data.landing === true)) ?? null;
}

const verifiedSha = run => landingHolder(run)?.data.before ?? null;

function enterLanding(run) {
  const data = { ...run.batch.data, phase: 'merging', landing: true };
  const entered = kv.transaction(run.db, () => {
    if (landingHolder(run)) return false;
    return run.db.prepare("UPDATE batches SET data = ?, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(JSON.stringify(data), run.now, run.batch.id).changes === 1;
  });
  if (entered) run.batch = store.getBatch(run.db, run.batch.id);
  return entered;
}

module.exports = {
  LANDING, createRun, save, decide, decisionOf, decideOnce, effect, mark, idOf, jiraOf, gitOf, gitArgs,
  versionRow, branchOf, activeKeys, findJob, ensureJob, isHeld, isWaiting, isBroken, enterLanding, verifiedSha,
};
