const kv = require('../kv.cjs');
const { resolveWait } = require('../pings.cjs');
const { openTracked } = require('../bugs/dry-release-waits.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('../bugs/effects.cjs');
const { releaseTarget } = require('./target.cjs');

const MAX_FAILED_ROUNDS = 2;
const EMPTY = { result: null, failedRounds: 0, runs: 0, run: null, blocked: null, build: null, waits: {} };
const stateKey = (project, version) => `e2e:${project}:${version}`;

const load = (db, project, version) => ({ ...EMPTY, waits: {}, ...kv.get(db, stateKey(project, version)) });
const save = (db, project, version, state, now) => kv.set(db, stateKey(project, version), state, now);

function versionsWithRun(db, project) {
  const prefix = stateKey(project, '');
  return kv.keys(db, prefix).filter(key => kv.get(db, key).run || kv.get(db, key).build?.jobId).map(key => key.slice(prefix.length));
}

function decide(ctx, project, code, action, evidence, now) {
  record(ctx.db, { project: project.key, code, ruleVersion: ruleVersionOf(ctx, project.key), evidence, action }, now);
}

function setWait(ctx, project, state, name, wanted, { role, subject, link = null }, now) {
  const id = state.waits[name];
  const open = id != null && ctx.db.prepare("SELECT 1 FROM waits WHERE id = ? AND state = 'open'").get(id);
  if (wanted && !open) state.waits[name] = openTracked(ctx, project, { role, subject, link }, now);
  if (!wanted && id != null) {
    resolveWait(ctx.db, id, now);
    delete state.waits[name];
  }
}

function closeWaits(ctx, project, version, now) {
  const state = load(ctx.db, project.key, version);
  for (const name of Object.keys(state.waits)) setWait(ctx, project, state, name, false, {}, now);
  save(ctx.db, project.key, version, state, now);
}

const versionTip = (ctx, project, version) => (ctx.bugs.versionTip ?? releaseTarget)(ctx, project, version);

const usable = (result, tree) => Boolean(result && tree && result.tree === tree);

function conditionOf(state, tip) {
  const { result } = state;
  if (!usable(result, tip?.tree)) return { ok: null, detail: 'chưa có' };
  const at = `cây ${result.tree.slice(0, 8)}`;
  if (result.status === 'pass') return { ok: true, detail: `E2E đạt trên ${at}` };
  if (result.status === 'accepted') return { ok: true, detail: `QA ${result.accepted.by} chấp nhận E2E trên ${at}` };
  return { ok: false, detail: `E2E còn lỗi trên ${at}: ${result.failures.slice(0, 5).map(f => f.id).join(', ') || 'chưa chạy đủ'}` };
}

async function sixthCondition(ctx, project, version) {
  const state = load(ctx.db, project.key, version.version);
  if (!state.result) return { ok: null, detail: 'chưa có' };
  return conditionOf(state, await versionTip(ctx, project, version));
}

module.exports = {
  load, save, versionsWithRun, decide, setWait, closeWaits, versionTip, usable, conditionOf, sixthCondition, stateKey, MAX_FAILED_ROUNDS,
};
