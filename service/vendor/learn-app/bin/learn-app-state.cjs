#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const S = require('../lib/learn-app-state.cjs');
const { isSecretPath } = require('../lib/secret-files.cjs');
const L = require('../lib/looper-steps.cjs');
const F = require('../lib/looper-flow.cjs');
const { checkStep, readPlans } = require('../lib/looper-checks.cjs');
const { resync: resyncState } = require('../lib/resync.cjs');
const { plan } = require('../lib/plan-commands.cjs');
const { git, gitSucceeds, firstLine, fail, print, option } = require('../lib/cli-io.cjs');
const { feature, decide, allow } = require('../lib/decision-commands.cjs');
const { handoff } = require('../lib/handoff-commands.cjs');
const { verdict, accept } = require('../lib/verdict-commands.cjs');
const { manifestSummary } = require('../lib/manifest-summary.cjs');
const { planWaves, questions } = require('../lib/insight-commands.cjs');
const { sdkRequest } = require('../lib/sdk-requests.cjs');
const { startPlans, merge, reopen, dropWorktrees, runningPlans, parallelLimit, plansToStart } = require('../lib/parallel-commands.cjs');
const { migrate } = require('../lib/migrate-state.cjs');
const { variant } = require('../lib/build-variant.cjs');
const { lessonsPrepare, lessonsPublish, lessonsSync } = require('../lib/lessons-commands.cjs');
const { waitPO, setWaiting, clearWaiting } = require('../lib/autopilot.cjs');
const { usage, timeline } = require('../lib/usage-commands.cjs');
const { appendJsonl } = require('../lib/tracking.cjs');
const { clearBlocked } = require('../lib/headless.cjs');
const { headlessStart, headlessBlock, guardCommand } = require('../lib/headless-commands.cjs');

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function recordStepChange(root, before, after) {
  if (before !== after) {
    appendJsonl(root, 'steps.jsonl', { at: new Date().toISOString(), from: before, to: after });
    clearWaiting(root);
    clearBlocked(root);
  }
}

function awaitAgents(root) {
  if (process.argv.includes('--clear')) {
    clearWaiting(root);
    print({ cleared: true });
    return;
  }
  const step = option('step') || S.readState(root).step;
  setWaiting(root, step);
  print({ waiting: step });
}

function gateCommit(root, gate) {
  const sha = git(root, ['log', '-1', '--format=%H', `--grep=^learn-app: ${gate} approved$`]);
  return sha || undefined;
}

function init(cwd) {
  const caseKind = option('case');
  const appId = option('app');
  if (!['existing', 'new'].includes(caseKind) || !appId) fail('Cần --case existing|new và --app <mã app>');
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (fs.existsSync(path.join(root, S.DIR, 'state.json'))) fail('App này đã có .learn-app — dùng lệnh status để xem đang ở đâu');
  if (!slug(appId) || !/^[A-Za-z0-9_-]+$/.test(appId)) fail('Mã app chỉ gồm chữ không dấu, số, gạch ngang hoặc gạch dưới, ví dụ AAP864');
  const branch = `learn-app/${slug(appId)}`;
  const startBranch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (startBranch !== branch) {
    const exists = gitSucceeds(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
    git(root, exists ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch]);
  }
  fs.mkdirSync(path.join(root, S.DIR, 'gates'), { recursive: true });
  fs.writeFileSync(path.join(root, S.DIR, '.gitignore'), 'sdk-src/\nhandoff.json\ntracking/\nlessons/\nwt/\n');
  fs.writeFileSync(path.join(root, S.DIR, 'gates', 'approvals.md'), '# Phê duyệt của PO\n');
  const state = S.newState(caseKind, appId);
  state.baseBranch = startBranch === 'HEAD' || startBranch.startsWith('learn-app/') ? null : startBranch;
  state.startedAt = new Date().toISOString();
  state.runId = `${appId}-${state.startedAt.replace(/[-:]/g, '').replace(/\..*$/, '')}`;
  S.writeState(root, state);
  appendJsonl(root, 'steps.jsonl', { at: state.startedAt, from: null, to: state.step });
  print({ root, branch, step: state.step });
}

function status(root) {
  const state = S.readState(root);
  const gates = Object.fromEntries(S.GATE_ORDER.map(g => [g, { ...state.gates[g], commit: state.gates[g].status === 'approved' ? gateCommit(root, g) : undefined }]));
  print({
    app: state.app,
    case: state.case,
    step: state.step,
    stepLabel: L.STEP_LABEL[state.step],
    running: runningPlans(state),
    parallel: parallelLimit(),
    buildVariant: state.buildVariant || 'devDebug',
    rawSpecVersion: state.rawSpecVersion || 1,
    baseCommit: gateCommit(root, 'g1') || null,
    judgeFails: state.judgeFails || {},
    plans: readPlans(root).map(p => ({ id: p.id, priority: p.priority, depends: p.depends, ...(state.plans[p.id] || { status: 'todo' }) })),
    loops: state.loops,
    gates,
    features: state.features,
    openDecisions: state.features.flatMap(f => (f.decisions || []).filter(d => !d.choice).map(d => ({ feature: f.id, ...d }))),
    allowances: state.allowances || {},
  });
}

function next(root) {
  const state = S.readState(root);
  const before = state.step;
  const result = F.advance(root, state);
  if (!result.ok) {
    print({ ...result, stepLabel: L.STEP_LABEL[state.step] });
    process.exit(2);
  }
  S.writeState(root, state);
  recordStepChange(root, before, state.step);
  print({ ...result, stepLabel: L.STEP_LABEL[state.step] });
}

function back(root) {
  const state = S.readState(root);
  const before = state.step;
  const result = F.goBack(root, state, option('to'), option('reason'), option('plan'), process.argv.includes('--self'), process.argv.includes('--by-service'));
  if (!result.ok) {
    if (result.exhausted) waitPO(root, result.error);
    console.error(result.error);
    process.exit(result.exhausted ? 3 : 2);
  }
  S.writeState(root, state);
  recordStepChange(root, before, state.step);
  const removed = dropWorktrees(root, result.drop);
  if (result.self) require('../lib/auto-decisions-log.cjs').writeAutoDecisions(root);
  print({ ...result, removed, stepLabel: L.STEP_LABEL[state.step] });
}

function resync(root) {
  const state = S.readState(root);
  const before = state.step;
  const result = resyncState(root, state);
  S.writeState(root, state);
  recordStepChange(root, before, state.step);
  print({ ...result, stepLabel: L.STEP_LABEL[state.step] });
}

function fixAttempt(root, fingerprint) {
  if (!fingerprint) fail('Cần dấu vân tay lỗi');
  const state = S.readState(root);
  const attempts = (state.fixAttempts[fingerprint] || 0) + 1;
  state.fixAttempts[fingerprint] = attempts;
  S.writeState(root, state);
  if (attempts >= 3) waitPO(root, `lỗi "${fingerprint}" sửa ${attempts} lần chưa được — báo PO, nhờ dev`);
  print({ fingerprint, attempts, exhausted: attempts >= 3 });
}

function stagedSecrets(root) {
  return git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
    .filter(isSecretPath);
}

function approve(root, gate) {
  if (!Object.values(L.GATE_AT).includes(gate)) fail('Cổng phải là g1 hoặc g3');
  const quote = option('quote');
  if (!quote) fail('Cần --quote: lời PO duyệt, ghi nguyên văn');
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.startsWith('learn-app/')) fail(`Chỉ ghi checkpoint trên branch learn-app/*, đang ở ${branch}`);
  const state = S.readState(root);
  const before = state.step;
  if (state.gates[gate].status === 'approved') fail(`Cổng ${gate} đã được duyệt.`);
  if (F.gateDue(state) !== gate) {
    const at = Object.keys(L.GATE_AT).find(step => L.GATE_AT[step] === gate);
    fail(`${F.GATE_NAME[gate]} được duyệt ở bước ${at}; đang ở bước ${state.step}.`);
  }
  if (!gitSucceeds(root, ['config', 'user.email'])) fail('Máy này chưa cấu hình git user.email nên chưa tạo được checkpoint. Nhờ dev chạy: git config --global user.email <email>');
  const missing = checkStep(root, state, state.step);
  if (missing.length) fail(`Chưa duyệt được, bước ${state.step} còn thiếu:\n- ${missing.join('\n- ')}`);
  git(root, ['add', '-A']);
  const secrets = stagedSecrets(root);
  if (secrets.length) {
    git(root, ['reset', '-q']);
    fail(`Không commit được vì có file bí mật chưa được gitignore: ${secrets.join(', ')}. Thêm chúng vào .gitignore rồi duyệt lại.`);
  }
  git(root, ['reset', '-q']);
  const approvalsFile = path.join(root, S.DIR, 'gates', 'approvals.md');
  const approvalsBefore = fs.readFileSync(approvalsFile, 'utf8');
  const stateBefore = JSON.parse(JSON.stringify(state));
  const at = new Date().toISOString();
  try {
    fs.appendFileSync(approvalsFile, `\n- ${at} · ${gate} · PO: "${quote}"\n`);
    state.gates[gate] = { status: 'approved', at };
    const moved = F.advance(root, state);
    if (!moved.ok) throw new Error(moved.missing.join('; '));
    S.writeState(root, state);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', `learn-app: ${gate} approved`]);
  } catch (error) {
    fs.writeFileSync(approvalsFile, approvalsBefore);
    S.writeState(root, stateBefore);
    gitSucceeds(root, ['reset', '-q']);
    fail(`Không tạo được checkpoint commit nên cổng ${gate} chưa được ghi là đã duyệt. Lý do: ${firstLine(error)}`);
  }
  recordStepChange(root, before, state.step);
  print({ gate, step: state.step, start: plansToStart(root, state).map(p => p.id), commit: git(root, ['rev-parse', 'HEAD']) });
}

function main() {
  const [command, argument] = process.argv.slice(2);
  const standalone = { 'lessons-prepare': lessonsPrepare, 'lessons-publish': lessonsPublish, 'headless-start': () => headlessStart(process.cwd()), 'headless-block': () => headlessBlock(process.cwd()) };
  if (standalone[command]) {
    standalone[command]();
    return;
  }
  if (command === 'init') {
    init(process.cwd());
    return;
  }
  const root = S.findAppRoot(process.cwd());
  if (!root) fail('Chưa có .learn-app ở đây — chạy init trước');
  try { require('../lib/plugin-version.cjs').assertRoot(root); } catch (error) { fail(error.message); }
  const commands = { status, next, back, resync, await: awaitAgents, plan, verdict, accept, 'manifest-summary': manifestSummary, 'manifest-resolve': root => print(require('../lib/manifest-resolve.cjs').resolveManifest(root)), 'manifest-diff': root => print(require('../lib/manifest-diff.cjs').diffManifest(root)), 'digest-prefill': root => { const r = require('../lib/digest-prefill.cjs').digestPrefill(root, option('plan')); if (r.error) fail(r.error); print(r); }, 'plan-waves': planWaves, questions, 'sdk-request': sdkRequest, 'start-plans': startPlans, merge, reopen, feature, decide, allow, 'fix-attempt': fixAttempt, approve, handoff, variant, migrate, 'lessons-sync': lessonsSync, usage, timeline, 'wait-po': root => print(waitPO(root, option('reason'))), 'discord-wait': root => require('../lib/discord-commands.cjs').discordWait(root), 'discord-say': root => require('../lib/discord-commands.cjs').discordSay(root) };
  if (!commands[command]) fail(`Lệnh không hợp lệ: ${command}`);
  guardCommand(root, command);
  commands[command](root, argument);
}

try {
  main();
} catch (error) {
  fail(`learn-app-state gặp lỗi: ${firstLine(error)}`);
}
