const kv = require('../kv.cjs');
const { openWait, resolveWait } = require('../pings.cjs');
const { openDryWaits, dryEffects, resetOrder } = require('./dry-traces.cjs');
const { decide, gitOf, gitArgs, branchOf, verifiedSha } = require('./phase-kit.cjs');

const RECHECK_MS = 15 * 60 * 1000;
const refusedKey = (project, version) => `bug-live-refused:${project}:${version}`;

function pushedLive(run, sha) {
  const { project, version } = run.batch;
  return run.db.prepare(
    "SELECT e.result FROM effects e JOIN batches b ON b.id = e.batch_id WHERE b.project = ? AND b.version = ? AND e.state = 'done' AND e.id LIKE '%:-:push' AND e.id NOT LIKE 'dry:%'",
  ).all(project, version).some(row => JSON.parse(row.result)?.sha === sha);
}

async function mirrorMatches(run) {
  const { workspace, landing } = gitOf(run);
  await workspace.ensureMirror(gitArgs(run));
  const versionBranch = branchOf(run);
  const sha = verifiedSha(run) ?? await landing.versionTip(gitArgs(run, { versionBranch }));
  if (!sha || pushedLive(run, sha)) return true;
  return landing.isPublished(gitArgs(run, { versionBranch, sha }));
}

async function dryReason(run) {
  const { project, version } = run.batch;
  if (dryEffects(run.db, project, version).length) return 'bản còn việc của lần chạy khô';
  if (openDryWaits(run.db, project, version).length) return 'còn việc chờ người mở lúc chạy khô';
  return (await mirrorMatches(run)) ? null : 'nhánh version trên mirror có commit không có trên GitHub';
}

function refuse(run, key, known, reason) {
  const { project, version } = run.batch;
  if (known) {
    kv.set(run.db, key, { ...known, until: run.now + RECHECK_MS }, run.now);
    return;
  }
  kv.transaction(run.db, () => {
    decide(run, 'X08', 'live-refused', { reason });
    const subject = `${project} ${version}: chưa chạy live được (${reason}); ${resetOrder(project, version)}`;
    const waitId = openWait(run.db, { project, role: 'dev', subject }, run.now);
    kv.set(run.db, key, { waitId, until: run.now + RECHECK_MS }, run.now);
  });
}

function clearRefusal(db, project, version, now) {
  const key = refusedKey(project, version);
  const known = kv.get(db, key);
  if (!known) return;
  resolveWait(db, known.waitId, now);
  kv.del(db, key);
}

async function liveReady(run) {
  if (!run.live) return true;
  const { project, version } = run.batch;
  const key = refusedKey(project, version);
  const known = kv.get(run.db, key);
  if (known && run.now < known.until) return false;
  const reason = await dryReason(run);
  if (reason) refuse(run, key, known, reason);
  else clearRefusal(run.db, project, version, run.now);
  return reason === null;
}

module.exports = { liveReady, clearRefusal };
