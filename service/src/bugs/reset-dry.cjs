const kv = require('../kv.cjs');
const store = require('./store.cjs');
const { resolveWait } = require('../pings.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { openDryWaits, dryEffects, dryWaitsKey, resetOrder } = require('./dry-traces.cjs');
const { releaseKey } = require('./release.cjs');
const { closedKey } = require('./closing.cjs');
const { deferKey } = require('./defer.cjs');
const e2e = require('../e2e/state.cjs');
const { buildsKey } = require('../e2e/builds.cjs');
const { clearRefusal } = require('./live-claim.cjs');

const ACTIVE = ['open', 'running'];
const PER_TICKET = ['bug-tries', 'bug-waits', 'bug-wait-status', 'bug-skip'];

function checkIdle(ctx, project, version) {
  const open = store.listBatches(ctx.db, { project: project.key, version, states: ACTIVE });
  if (open.length) throw new Error(`${project.key} ${version} còn đợt #${open.map(b => b.id).join(', #')} chưa xong; ${resetOrder(project.key, version)}`);
  const { run, build } = e2e.load(ctx.db, project.key, version);
  if (run || build?.jobId) throw new Error(`${project.key} ${version} còn E2E đang chạy, chờ xong rồi dọn`);
}

function dryKeys(db, project, version) {
  const last = new Map();
  for (const batch of store.listBatches(db, { project, version })) {
    for (const key of batch.keys) if (batch.data.phase !== undefined) last.set(key, batch.data.live === true);
  }
  const mine = key => (store.getTicket(db, project, key)?.version ?? version) === version;
  return [...last].filter(([key, live]) => !live && mine(key)).map(([key]) => key);
}

function claimedLive(db, project, key) {
  const id = kv.get(db, `bug-claim:${project}:${key}`);
  return id !== null && store.getBatch(db, id)?.data.live === true;
}

function clearTicket(db, project, key, now) {
  if (claimedLive(db, project, key)) {
    return db.prepare("UPDATE tickets SET state = 'accepted', verdict = NULL, batch_id = NULL, updated_at = ? WHERE project = ? AND key = ?").run(now, project, key);
  }
  kv.del(db, `bug-claim:${project}:${key}`);
  return db.prepare('DELETE FROM tickets WHERE project = ? AND key = ?').run(project, key);
}

function clearTickets(db, project, keys, now) {
  let count = 0;
  for (const key of keys) {
    for (const id of kv.get(db, `bug-waits:${project}:${key}`) ?? []) resolveWait(db, id, now);
    for (const name of PER_TICKET) kv.del(db, `${name}:${project}:${key}`);
    count += Number(clearTicket(db, project, key, now).changes);
  }
  return count;
}

function clearRelease(db, project, version, now) {
  const { runs, waits } = e2e.load(db, project, version);
  for (const id of [...Object.values(waits), ...Object.values(kv.get(db, releaseKey(project, version))?.waits ?? {})]) resolveWait(db, id, now);
  for (const key of [closedKey, deferKey, buildsKey, releaseKey]) kv.del(db, key(project, version));
  if (runs) kv.set(db, e2e.stateKey(project, version), { runs }, now);
  else kv.del(db, e2e.stateKey(project, version));
}

function clearRows(ctx, project, version, sha, now) {
  const { db } = ctx;
  return kv.transaction(db, () => {
    checkIdle(ctx, project, version);
    const effects = dryEffects(db, project.key, version);
    const waits = openDryWaits(db, project.key, version);
    for (const id of effects) db.prepare('DELETE FROM effects WHERE id = ?').run(id);
    for (const id of waits) resolveWait(db, id, now);
    kv.del(db, dryWaitsKey(project.key, version));
    const tickets = clearTickets(db, project.key, dryKeys(db, project.key, version), now);
    clearRefusal(db, project.key, version, now);
    clearRelease(db, project.key, version, now);
    require('../specs/release-hooks.cjs').reopenLandedDry(db, project.key, version, now);
    const done = { effects: effects.length, waits: waits.length, tickets, sha };
    record(db, { project: project.key, code: 'X08', ruleVersion: ruleVersionOf(ctx, project.key), evidence: { version, ...done }, action: 'reset-dry' }, now);
    return done;
  });
}

async function resetDry(ctx, project, version) {
  store.checkVersion(version);
  const now = ctx.now?.() ?? Date.now();
  if (project.live !== false) throw new Error(`project ${project.key} đang live, chỉ dọn khi live: false; ${resetOrder(project.key, version)}`);
  checkIdle(ctx, project, version);
  const { workspace, landing } = ctx.bugs.git;
  const git = { dzHome: ctx.dzHome, project, githubUrl: ctx.bugs.githubUrl };
  await workspace.ensureMirror(git);
  const versionBranch = store.getVersion(ctx.db, project.key, version)?.branch ?? workspace.versionBranch(version);
  const { sha } = await landing.restoreVersion({ ...git, versionBranch });
  return clearRows(ctx, project, version, sha, now);
}

module.exports = { resetDry };
