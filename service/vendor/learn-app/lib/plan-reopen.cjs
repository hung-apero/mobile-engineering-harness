const crypto = require('crypto');
const { read, readPlans, manifestFeatures } = require('./looper-parse.cjs');
const { clearVerdicts, readVerdict, hashInputs, changedInputs } = require('./verdicts.cjs');

// One way to send a plan back to be coded: status todo, its review verdicts and failure counts gone.
// Returns the worktree to remove, if it had one.
function reopenPlan(root, state, id, why) {
  const previous = (state.plans || {})[id] || {};
  state.plans[id] = { status: 'todo', files: [], reopened: why, resetAt: new Date().toISOString() };
  clearVerdicts(root, [`review:${id}`]);
  state.judgeFails = Object.fromEntries(Object.entries(state.judgeFails || {}).filter(([key]) => key !== `review:${id}`));
  return previous.worktree ? { plan: id, worktree: previous.worktree, branch: previous.branch } : null;
}

function reopenFeatures(root, state, id) {
  const plan = readPlans(root).find(p => p.id === id);
  const mine = new Set(plan ? plan.features : []);
  state.features = (state.features || []).map(f => (mine.has(f.id) && f.status === 'done' ? { ...f, status: 'todo' } : f));
}

// What the plan's features are in the manifest; a merged plan whose features changed there (spec changed) is
// coded again even when the planner kept its plan file.
function featureHash(root, plan) {
  const wanted = new Set(plan.features || []);
  const entries = manifestFeatures(read(root, 'app-manifest.yaml') || '').filter(f => wanted.has(f.id));
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function harnessChanged(root, key, state) {
  const verdict = readVerdict(root, key);
  if (!verdict) return false;
  if (verdict.broken) return true;
  const now = hashInputs(root, key, state);
  return changedInputs(now, verdict.inputs).some(rel => rel.startsWith('.learn-app/'));
}

// Back in coding after a return to planning: plans no longer in plans/ leave the state (with their verdicts and
// debts); a merged plan whose plan file, test steps, lessons or manifest features changed is coded again. Code is
// not compared: once merged, later plans and git's line endings may touch it without the plan being wrong.
function replanned(root, state) {
  const reopened = [];
  const plans = readPlans(root);
  const ids = new Set(plans.map(p => p.id));
  for (const id of Object.keys(state.plans || {})) {
    if (!ids.has(id)) {
      reopenPlan(root, state, id, 'removed');
      delete state.plans[id];
      continue;
    }
    const entry = state.plans[id];
    const plan = plans.find(p => p.id === id);
    const featuresMoved = entry.featureHash && entry.featureHash !== featureHash(root, plan);
    if (entry.status === 'merged' && (featuresMoved || harnessChanged(root, `review:${id}`, state))) {
      reopenPlan(root, state, id, 'replan');
      reopened.push(id);
    }
  }
  return reopened;
}

module.exports = { reopenPlan, reopenFeatures, replanned, featureHash, harnessChanged };
