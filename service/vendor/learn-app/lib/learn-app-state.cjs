const fs = require('fs');
const path = require('path');

const DIR = '.learn-app';
const SCHEMA = 3;
const GATE_ORDER = ['g1', 'g3'];

const WORKTREE = /[\\/]\.learn-app[\\/]wt[\\/][^\\/]+(?:[\\/]|$)/;

// Plan worktrees live at <root>/.learn-app/wt/<plan>/ and carry a tracked copy of .learn-app; the one real
// state is always the main root's.
function mainRoot(dir) {
  const match = path.resolve(dir).match(WORKTREE);
  return match ? path.resolve(dir).slice(0, match.index) : null;
}

function worktreeOf(file) {
  const match = path.resolve(file).match(/[\\/]\.learn-app[\\/]wt[\\/]([^\\/]+)/);
  return match ? match[1] : null;
}

// <root>/.learn-app/wt/<plan>/.learn-app/… is a tracked copy nobody reads; the real one is <root>/.learn-app/….
function harnessInWorktree(target) {
  const match = target.match(/^(.*?)[\\/]\.learn-app[\\/]wt[\\/][^\\/]+[\\/](\.learn-app(?:[\\/].*)?)$/);
  return match ? path.join(match[1], match[2]) : null;
}

function findAppRoot(start) {
  const main = mainRoot(start);
  if (main && fs.existsSync(path.join(main, DIR, 'state.json'))) return main;
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, DIR, 'state.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function writeJsonAtomic(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function statePath(root) {
  return path.join(root, DIR, 'state.json');
}

function readState(root) {
  const state = JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
  if (state.schema !== SCHEMA) {
    throw new Error(`.learn-app ở ${root} là bản cũ (schema ${state.schema}), không làm tiếp được với learn-app bản này. Chạy learn-app-state.cjs migrate để chuyển sang bản mới (giữ phần đã làm), rồi làm tiếp.`);
  }
  return normalize(state, root);
}

// Runs from before parallel coding: the reviewing step is folded into coding, a plan reviewed in place is
// already on the integration branch, and the plan that was current keeps working in the main root.
function normalize(state, root) {
  if (state.step === 'reviewing') state.step = 'coding';
  if (state.step === 'handoff' && ((state.gates || {}).g3 || {}).status !== 'approved' && !fs.existsSync(path.join(root, DIR, 'smoke', 'report.md'))) {
    state.step = 'smoke';
    ensureIgnoredLines(root, ['smoke/shots/']);
  }
  if (state.currentPlan) {
    const current = state.plans[state.currentPlan] || { status: 'todo', files: [] };
    state.plans[state.currentPlan] = { ...current, status: current.status === 'todo' ? 'coding' : current.status, worktree: null };
  }
  for (const plan of Object.values(state.plans || {})) {
    if (plan.status === 'reviewed' && !('worktree' in plan)) plan.status = 'merged';
  }
  delete state.currentPlan;
  return state;
}

// Adds lines to .learn-app/.gitignore when missing (apps initialised by an older harness).
function ensureIgnoredLines(root, lines) {
  const file = path.join(root, DIR, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = text.split(/\r?\n/);
  const add = lines.filter(line => !have.includes(line));
  if (add.length) fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
}

function writeState(root, state) {
  writeJsonAtomic(statePath(root), require('./plugin-version.cjs').stamp(state));
}

// Read-modify-write under a lock, for commands that run beside others (merges, background agents' verdicts).
function updateState(root, change) {
  const { withLock } = require('./file-lock.cjs');
  return withLock(path.join(root, DIR, '.state.lock'), () => {
    const state = readState(root);
    const result = change(state);
    writeState(root, state);
    return result === undefined ? state : result;
  }, 15000);
}

// Where a plan's code lives: its worktree while it is being coded, the main root otherwise.
function codeRoot(root, state, planId) {
  const plan = (state.plans || {})[planId];
  return plan && plan.worktree ? path.join(root, plan.worktree) : root;
}

function newState(caseKind, appId) {
  return {
    schema: SCHEMA,
    case: caseKind,
    app: appId,
    step: 'spec',
    gates: { g1: { status: 'pending' }, g3: { status: 'pending' } },
    features: [],
    plans: {},
    loops: {},
    history: [],
    fixAttempts: {},
    vendored: {},
  };
}

module.exports = { DIR, SCHEMA, GATE_ORDER, findAppRoot, mainRoot, worktreeOf, harnessInWorktree, codeRoot, readState, writeState, updateState, ensureIgnoredLines, writeJsonAtomic, newState };
