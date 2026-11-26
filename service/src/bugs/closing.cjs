const kv = require('../kv.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { listBuilds } = require('../e2e/builds.cjs');

const MAX_BUILDS = 3;
const closedKey = (project, version) => `release-closed:${project}:${version}`;

const closedAt = (db, project, version) => kv.get(db, closedKey(project, version))?.at ?? null;
const isClosed = (db, project, version) => closedAt(db, project, version) !== null;

function featuresPending(ctx, project, version) {
  if (ctx.bugs.featuresPending) return ctx.bugs.featuresPending(project, version);
  return ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project = ? AND kind = 'feature' AND state IN ('queued', 'starting', 'running', 'parked')").get(project.key).n > 0;
}

function closeWhenReady(ctx, project, version, conditions, now) {
  const { db } = ctx;
  const name = version.version;
  if (isClosed(db, project.key, name) || conditions[1].ok !== true) return false;
  if (listBuilds(db, project.key, name).length === 0 || featuresPending(ctx, project, version)) return false;
  kv.set(db, closedKey(project.key, name), { at: now }, now);
  record(db, { project: project.key, code: 'R03', ruleVersion: ruleVersionOf(ctx, project.key), evidence: { version: name }, action: 'version-closed' }, now);
  return true;
}

function buildsAfterClose(db, project, version) {
  const at = closedAt(db, project, version);
  return at === null ? 0 : listBuilds(db, project, version).filter(build => build.at > at).length;
}

module.exports = { closedKey, isClosed, closedAt, closeWhenReady, buildsAfterClose, featuresPending, MAX_BUILDS };
