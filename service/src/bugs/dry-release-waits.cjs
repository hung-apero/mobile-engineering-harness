const kv = require('../kv.cjs');
const { openWait, resolveWait } = require('../pings.cjs');
const { dryWaitsKey } = require('./dry-traces.cjs');

const trackedKey = project => dryWaitsKey(project, '#release');
const tracked = (db, project) => kv.get(db, trackedKey(project)) ?? [];
const openRow = (db, id) => db.prepare("SELECT role, subject, link FROM waits WHERE id = ? AND state = 'open'").get(id);

function openTracked({ db }, project, { role, subject, link = null }, now) {
  const id = openWait(db, { project: project.key, role, subject, link }, now);
  if (project.live !== true) kv.set(db, trackedKey(project.key), [...new Set([...tracked(db, project.key).filter(old => openRow(db, old)), id])], now);
  return id;
}

function adoptDry({ db }, project, state, now) {
  if (project.live !== true) return;
  const dry = tracked(db, project.key);
  if (dry.length === 0) return;
  for (const [name, id] of Object.entries(state.waits)) {
    if (!dry.includes(id)) continue;
    const row = openRow(db, id);
    resolveWait(db, id, now);
    delete state.waits[name];
    if (row) state.waits[name] = openWait(db, { project: project.key, role: row.role, subject: row.subject, link: row.link }, now);
  }
  kv.set(db, trackedKey(project.key), tracked(db, project.key).filter(id => openRow(db, id)), now);
}

module.exports = { openTracked, adoptDry };
