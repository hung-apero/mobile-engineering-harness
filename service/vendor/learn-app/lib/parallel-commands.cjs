const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const S = require('./learn-app-state.cjs');
const W = require('./worktrees.cjs');
const P = require('./plan-schedule.cjs');
const { git, fail, print, option } = require('./cli-io.cjs');
const { readPlans } = require('./looper-parse.cjs');
const { planMissing } = require('./plan-progress.cjs');
const { verdictMissing } = require('./verdicts.cjs');
const { overlaps, sharedFiles } = require('./plan-overlap.cjs');
const { withSlot } = require('./slot-lock.cjs');
const { runBuild, defaultTasks } = require('../bin/build.cjs');
const { reopenPlan, reopenFeatures, featureHash } = require('./plan-reopen.cjs');

const CONFLICTS_BEFORE_REPLAN = 2;

function record(state, entry) {
  state.history = [...(state.history || []), { at: new Date().toISOString(), ...entry }];
}

function integrationBranch(root) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.startsWith('learn-app/') || branch.includes('-plan-')) fail(`Thư mục chính phải ở branch learn-app/<mã>, đang ở ${branch}`);
  return branch;
}

function ignoreWorktrees(root) {
  const file = path.join(root, S.DIR, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = current.split(/\r?\n/);
  const add = ['wt/', '.state.lock'].filter(line => !lines.includes(line));
  if (add.length) fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
}

// Code written in the main root (runs from before parallel coding) goes into the integration branch first,
// or the worktrees would start without it.
function commitRootCode(root, message) {
  try {
    return W.commitAll(root, message);
  } catch (error) {
    fail(error.message);
  }
}

function startPlans(root) {
  if (S.readState(root).step !== 'coding') fail(`Chỉ bắt đầu plan ở bước coding, đang ở ${S.readState(root).step}`);
  const integration = integrationBranch(root);
  ignoreWorktrees(root);
  const committed = commitRootCode(root, 'learn-app: code before parallel plans');
  const started = S.updateState(root, state => {
    const out = [];
    for (const plan of P.plansToStart(root, state)) {
      const branch = P.planBranch(integration, plan.id);
      const wt = W.create(root, { plan: plan.id, branch, integration });
      state.plans[plan.id] = { status: 'coding', files: [], worktree: wt.rel, branch, base: wt.base, startedAt: new Date().toISOString() };
      record(state, { action: 'start-plan', from: 'coding', to: 'coding', plan: plan.id });
      out.push({ id: plan.id, dir: wt.dir, branch, base: wt.base, plan: `.learn-app/plans/${plan.file}`, screens: plan.screens });
    }
    return out;
  });
  const state = S.readState(root);
  const waiting = readPlans(root).filter(p => P.statusOf(state, p.id) === 'todo').map(p => p.id);
  print({ started, running: P.runningPlans(state), waiting, limit: P.parallelLimit(), ...(committed ? { committedRootCode: committed } : {}) });
}

function relative(root, file) {
  return (path.isAbsolute(file) ? path.relative(root, file) : file).split(path.sep).join('/');
}

// Files the plan changed that it did not claim: shared ones are refused, the rest are only noted.
// The worktree's tracked .learn-app copy is refused too — harness files live in the main root.
function outsideTouches(root, plan, changed) {
  const harness = changed.filter(f => f.startsWith(`${S.DIR}/`));
  if (!plan.touches) return { refused: harness, outside: [] };
  const shared = sharedFiles(root);
  const outside = changed.filter(f => !plan.touches.some(t => overlaps(t, f)) && !f.startsWith(`${S.DIR}/`));
  const refused = [...harness, ...(plan.kind === 'feature' ? outside.filter(f => shared.some(h => overlaps(h, f))) : [])];
  return { refused, outside };
}

// Only this plan's entry, the integration build and history change: other commands may have written state
// while the build ran.
function savePlan(root, id, patch, entry, build) {
  S.updateState(root, state => {
    state.plans[id] = { ...(state.plans[id] || {}), ...patch };
    if (build) state.integrationBuild = build;
    if (entry) record(state, entry);
  });
}

function stop(root, id, patch, output) {
  savePlan(root, id, patch);
  print(output);
  process.exit(2);
}

function finish(root, id, entry, commit, build) {
  const removal = entry.worktree ? W.remove(root, id, entry.branch) : { ok: true };
  const at = new Date().toISOString();
  const plan = readPlans(root).find(p => p.id === id);
  savePlan(root, id, { status: 'merged', worktree: null, mergedAt: at, commit, featureHash: plan ? featureHash(root, plan) : null, ...(removal.ok ? {} : { leftover: removal.error }) }, { action: 'merge-plan', from: 'coding', to: 'coding', plan: id }, build && { ok: true, at, plan: id, durationMs: build.durationMs });
  const state = S.readState(root);
  print({ plan: id, merged: true, commit, outside: entry.outside || [], ...(removal.ok ? {} : { leftover: `chưa xoá được worktree: ${removal.error}` }), start: P.plansToStart(root, state).map(p => p.id), running: P.runningPlans(state), allMerged: P.allMerged(readPlans(root), state) });
}

// A merge that stopped after git merged the branch only needs finishing: returns the merge commit, or null.
function alreadyMerged(root, id, entry) {
  if (entry.status !== 'reviewed' || !entry.branch) return null;
  const tip = gitOr(root, ['rev-parse', '--verify', '-q', `refs/heads/${entry.branch}`]);
  if (tip && tip !== entry.base && W.isAncestor(root, tip)) return gitOr(root, ['log', '-1', '--format=%H', `--since=${entry.startedAt || '1970-01-01'}`, `--grep=^learn-app: merge ${id}$`]) || git(root, ['rev-parse', 'HEAD']);
  if (!tip) return gitOr(root, ['log', '-1', '--format=%H', `--since=${entry.startedAt || '1970-01-01'}`, `--grep=^learn-app: merge ${id}$`]);
  return null;
}

function gitOr(root, args) {
  try {
    return git(root, args) || null;
  } catch {
    return null;
  }
}

function mergeSlot(root) {
  return `merge-${crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 10)}`;
}

function mergeWorktree(root, id, plan, entry) {
  const dir = path.join(root, entry.worktree);
  const integration = integrationBranch(root);
  if (W.mergeInProgress(dir)) fail(`Worktree của plan ${id} đang gộp dở — giải xung đột, commit, rồi plan --id ${id} --status coded`);
  try {
    W.commitAll(dir, `learn-app: ${id}`);
  } catch (error) {
    fail(error.message);
  }
  const changed = W.changedFiles(dir, integration).map(f => relative(dir, f));
  const { refused, outside } = outsideTouches(root, plan, changed);
  if (refused.length) fail(`Plan ${id} sửa file không được gộp: ${refused.join(', ')} — file .learn-app ghi ở thư mục chính; file dùng chung chuyển sang plan khung/nối (back --to planning) hoặc bỏ thay đổi đó`);
  const sync = W.syncIntegration(dir, integration);
  if (!sync.ok) {
    const conflicts = (entry.conflicts || 0) + 1;
    const replan = conflicts >= CONFLICTS_BEFORE_REPLAN ? ' Xung đột lần thứ hai — cân nhắc back --to planning: touches của các plan đang chồng nhau.' : '';
    stop(root, id, { status: 'conflict', conflicts, outside }, { plan: id, merged: false, conflict: sync.conflict, hint: `Gọi agent chủ plan giải xung đột trong ${entry.worktree}, commit, rồi plan --id ${id} --status coded (chấm lại).${replan}` });
  }
  // The plan's own changes now start from the integration tip.
  const base = git(dir, ['rev-parse', integration]);
  const build = runBuild(dir, defaultTasks(root), { root, label: `merge ${id}` });
  if (!build.ok) stop(root, id, { status: 'coded', base, outside }, { plan: id, merged: false, build: { ok: false, errors: build.errors, tail: build.tail }, hint: `Build sau khi gộp code mới nhất bị đỏ — gọi agent chủ plan sửa trong ${entry.worktree}, rồi chấm lại.` });
  const commit = W.mergeIntoRoot(root, entry.branch, `learn-app: merge ${id}`);
  finish(root, id, { ...entry, outside }, commit, build);
}

function merge(root) {
  const id = option('plan');
  const plan = readPlans(root).find(p => p.id === id);
  if (!plan) fail(`Cần --plan <id> của một plan trong .learn-app/plans/`);
  const state = S.readState(root);
  if (state.step !== 'coding') fail(`Chỉ gộp plan ở bước coding, đang ở ${state.step}`);
  const entry = state.plans[id] || {};
  const done = alreadyMerged(root, id, entry);
  if (done) {
    finish(root, id, entry, done, null);
    return;
  }
  if (entry.status !== 'reviewed') fail(`Plan ${id} đang ${entry.status || 'todo'} — chỉ gộp plan đã qua plan-reviewer (plan --status reviewed)`);
  const unfinished = [...planMissing(root, state, plan), ...verdictMissing(root, `review:${id}`, state)];
  if (unfinished.length) fail(`Plan ${id} chưa gộp được: ${unfinished.join(' · ')}`);
  // One merge at a time per app: sync, build and merge into the main root see the same integration tip.
  withSlot(mergeSlot(root), { label: `merge ${id}`, onWait: h => console.error(`đang chờ lần gộp khác xong: ${h.join(', ')}`) }, () => {
    if (entry.worktree) return mergeWorktree(root, id, plan, entry);
    const build = runBuild(root, defaultTasks(root), { root, label: `merge ${id}` });
    if (!build.ok) stop(root, id, { status: 'coded' }, { plan: id, merged: false, build: { ok: false, errors: build.errors, tail: build.tail }, hint: 'Build đỏ — gọi agent chủ plan sửa, rồi chấm lại.' });
    return finish(root, id, entry, commitRootCode(root, `learn-app: ${id}`), build);
  });
}

// From coding: send one plan back to be coded (PO wants a debt fixed, or chose differently than a provisional
// choice). Its worktree goes; plans depending on it keep their state.
function reopen(root) {
  const id = option('plan');
  const reason = option('reason');
  const byService = process.argv.includes('--by-service');
  if (!id || !reason) fail('Cần --plan <id> và --reason "<vì sao>"');
  if (!readPlans(root).some(p => p.id === id)) fail(`Không có plan ${id}`);
  const { step } = S.readState(root);
  if (step !== 'coding' && !(byService && step === 'planning')) fail('reopen dùng ở bước coding; ở testing dùng back --to coding --plan <id>');
  const drop = S.updateState(root, state => {
    const dropped = reopenPlan(root, state, id, reason);
    if (byService) reopenFeatures(root, state, id);
    record(state, { action: 'reopen', from: step, to: step, plan: id, reason, ...(byService ? { byService: true } : {}) });
    return dropped;
  });
  print({ plan: id, status: 'todo', removed: dropWorktrees(root, drop ? [drop] : []) });
}

function dropWorktrees(root, drop = []) {
  return drop.map(d => ({ plan: d.plan, ...W.remove(root, d.plan, d.branch) }));
}

const { runningPlans, parallelLimit, plansToStart } = P;

module.exports = { startPlans, merge, reopen, dropWorktrees, outsideTouches, runningPlans, parallelLimit, plansToStart };
