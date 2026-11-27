const kv = require('../kv.cjs');
const { openWait } = require('../pings.cjs');

const dryWaitsKey = (project, version) => `bug-dry-waits:${project}:${version}`;

function openBatchWait(run, { role, subject, link = null }) {
  const { db, project, batch, now } = run;
  const id = openWait(db, { project: project.key, role, subject, link }, now);
  if (run.live) return id;
  const key = dryWaitsKey(project.key, batch.version);
  kv.set(db, key, [...new Set([...(kv.get(db, key) ?? []), id])], now);
  return id;
}

function openDryWaits(db, project, version) {
  const ids = kv.get(db, dryWaitsKey(project, version)) ?? [];
  return ids.filter(id => db.prepare("SELECT 1 FROM waits WHERE id = ? AND state = 'open'").get(id));
}

function dryEffects(db, project, version) {
  return db.prepare(
    "SELECT e.id FROM effects e JOIN batches b ON b.id = e.batch_id WHERE b.project = ? AND b.version = ? AND e.id LIKE 'dry:%'",
  ).all(project, version).map(row => row.id);
}

const dryWaitIds = (db, project) => new Set(kv.keys(db, dryWaitsKey(project, '')).flatMap(key => kv.get(db, key)));

const resetOrder = (project, version) =>
  `thứ tự: dz pause ${project} → live: false → dz batch park từng đợt đang mở → dz bugs reset-dry ${project} ${version} → live: true → dz resume ${project}`;

module.exports = { openBatchWait, openDryWaits, dryEffects, dryWaitsKey, dryWaitIds, resetOrder };
