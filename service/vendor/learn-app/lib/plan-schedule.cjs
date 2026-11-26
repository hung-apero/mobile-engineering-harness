const S = require('./learn-app-state.cjs');
const { readPlans } = require('./looper-parse.cjs');

// A plan is running from the moment its worktree exists until it is merged.
const RUNNING = ['coding', 'coded', 'reviewed', 'conflict'];
// A plan holds a parallel coding slot only while it needs a coder (writing, or resolving a merge conflict).
// Once coded, its review and merge run in the background and no longer block the next plan from starting.
const CODING = ['coding', 'conflict'];
// waiting-po: the plan needs a PO answer; it holds no parallel slot until answered.
const PLAN_STATUSES = ['todo', ...RUNNING, 'waiting-po', 'merged'];

function parallelLimit(env = process.env) {
  const n = Number(env.LEARN_APP_PARALLEL);
  return Number.isInteger(n) && n > 0 ? n : 3;
}

function statusOf(state, id) {
  return ((state.plans || {})[id] || {}).status || 'todo';
}

function runningPlans(state) {
  return Object.keys(state.plans || {}).filter(id => RUNNING.includes(statusOf(state, id))).sort();
}

function codingPlans(state) {
  return Object.keys(state.plans || {}).filter(id => CODING.includes(statusOf(state, id)));
}

function readyPlans(plans, state) {
  return plans
    .filter(p => statusOf(state, p.id) === 'todo' && p.depends.every(dep => statusOf(state, dep) === 'merged'))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function allMerged(plans, state) {
  return plans.length > 0 && plans.every(p => statusOf(state, p.id) === 'merged');
}

// Plans the scheduler should start now, within the parallel coding limit (review/merge run in the background).
function plansToStart(root, state, env = process.env) {
  const free = parallelLimit(env) - codingPlans(state).length;
  const waiting = new Set(require('./questions.cjs').waitingPlans(root, state));
  return free > 0 ? readyPlans(readPlans(root), state).filter(p => !waiting.has(p.id)).slice(0, free) : [];
}

function planBranch(integration, id) {
  return `${integration}-plan-${id}`;
}

function planCodeRoot(root, state, id) {
  return S.codeRoot(root, state, id);
}

module.exports = { RUNNING, CODING, PLAN_STATUSES, parallelLimit, statusOf, runningPlans, codingPlans, readyPlans, allMerged, plansToStart, planBranch, planCodeRoot };
