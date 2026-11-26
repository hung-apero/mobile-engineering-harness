const kv = require('../kv.cjs');
const store = require('./store.cjs');
const polling = require('./polling.cjs');
const { resolveWait } = require('../pings.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { openDryWaits, dryWaitsKey } = require('./dry-traces.cjs');
const { clearRefusal } = require('./live-claim.cjs');
const { releaseKey } = require('./release.cjs');
const e2e = require('../e2e/state.cjs');

class FinishError extends Error {}

function ticketWaitIds(db, project, version) {
  return store.listTickets(db, { project, version }).flatMap(({ key }) => kv.get(db, `bug-waits:${project}:${key}`) ?? []);
}

function subjectWaitIds(db, project, version) {
  const exact = [`Kiểm bản cài ${project} ${version.version}`, `Bản ${version.version}: `, `Nhánh version ${version.version}: `];
  return db.prepare("SELECT id, subject FROM waits WHERE project = ? AND state = 'open'").all(project)
    .filter(({ subject }) => subject === exact[0] || subject.startsWith(exact[1]) || subject.startsWith(exact[2]) || subject.startsWith(`Merge PR ${version.branch} (`))
    .map(wait => wait.id);
}

function closeVersionWaits(ctx, project, version, now) {
  const { db } = ctx;
  const { key } = project;
  const state = kv.get(db, releaseKey(key, version.version));
  const ids = new Set([
    ...Object.values(state?.waits ?? {}), ...ticketWaitIds(db, key, version.version),
    ...subjectWaitIds(db, key, version), ...openDryWaits(db, key, version.version),
  ]);
  let closed = 0;
  for (const id of ids) if (resolveWait(db, id, now)) closed += 1;
  if (state) kv.set(db, releaseKey(key, version.version), { ...state, ready: 'none', waits: {} }, now);
  kv.del(db, dryWaitsKey(key, version.version));
  clearRefusal(db, key, version.version, now);
  e2e.closeWaits(ctx, project, version.version, now);
  return closed;
}

function finishVersion(ctx, project, version, outcome, now) {
  const { db } = ctx;
  const name = version.version;
  if (!['done', 'cancel'].includes(outcome)) throw new FinishError('kết quả phải là done hoặc cancel');
  if (version.state === 'closed') return { already: true, closed: 0 };
  return kv.transaction(db, () => {
    const active = store.listBatches(db, { project: project.key, version: name, states: ['open', 'running'] });
    if (active.length) throw new FinishError(`còn đợt #${active.map(b => b.id).join(', #')} chưa xong, gác trước bằng dz batch park <id>`);
    kv.set(db, polling.offKey(project.key, name), true, now);
    const freed = store.listTickets(db, { project: project.key, version: name, states: ['accepted'] }).map(ticket => ticket.key);
    for (const key of freed) store.setTicketState(db, project.key, key, 'accepted', 'skipped', now);
    db.prepare("UPDATE versions SET state = 'closed', polling = 0 WHERE project = ? AND version = ?").run(project.key, name);
    const jobs = db.prepare("UPDATE jobs SET state = 'failed', result = '{\"error\":\"version_closed\"}', finished_at = NULL WHERE project = ? AND kind = 'e2e' AND state = 'queued' AND key LIKE ?").run(project.key, `${name}#%`);
    const closed = closeVersionWaits(ctx, project, version, now);
    record(db, { project: project.key, code: 'R05', ruleVersion: ruleVersionOf(ctx, project.key), evidence: { version: name, outcome, waits: closed, freed: freed.slice(0, 50), e2e: Number(jobs.changes) }, action: outcome === 'done' ? 'released' : 'cancelled' }, now);
    return { already: false, closed };
  });
}

module.exports = { finishVersion, FinishError };
