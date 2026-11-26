const L = require('./looper-steps.cjs');
const { checkStep, readPlans, specVersions } = require('./looper-checks.cjs');
const { runningPlans, plansToStart, allMerged } = require('./plan-schedule.cjs');
const { reopenPlan, reopenFeatures, replanned } = require('./plan-reopen.cjs');
const { JUDGED_STEPS, clearVerdicts } = require('./verdicts.cjs');

const GATE_NAME = { g1: 'cổng 1 (spec đã làm rõ)', g3: 'cổng 3 (code đã sẵn sàng bàn giao)' };

function gateDue(state) {
  const gate = L.GATE_AT[state.step];
  if (!gate) return null;
  return gate;
}

function record(state, entry) {
  state.history = [...(state.history || []), { at: new Date().toISOString(), ...entry }];
}

function advance(root, state) {
  const missing = checkStep(root, state, state.step);
  const gate = gateDue(state);
  if (gate && state.gates[gate].status !== 'approved') missing.push(`cần PO duyệt ${GATE_NAME[gate]} (learn-app-state.cjs approve ${gate})`);
  if (missing.length) return { ok: false, step: state.step, running: runningPlans(state), missing };

  const from = state.step;
  let reopened = [];
  let debt = null;
  if (from === 'planning') {
    reopened = replanned(root, state);
    if (!plansToStart(root, state).length && !allMerged(readPlans(root), state)) return { ok: false, step: from, running: [], missing: ['không còn plan nào chưa làm — chạy lại planner hoặc quay lại bước planning'] };
    state.step = 'coding';
  } else if (from === 'spec') {
    const versions = specVersions(root);
    state.rawSpecVersion = versions[versions.length - 1];
    state.step = 'scout';
  } else if (from === 'handoff') {
    state.done = true;
  } else {
    if (from === 'smoke' && require('./smoke-checks.cjs').smokeDebt(root, state)) debt = `đã sửa ${L.SMOKE_LOOP_LIMIT} vòng mà app vẫn lỗi trên máy — chép các lỗi còn lại trong smoke/report.md vào .learn-app/debts.md (nợ, kèm ảnh), báo PO ở cổng 3`;
    state.step = L.nextStep(from);
    if (state.step === 'smoke') require('./learn-app-state.cjs').ensureIgnoredLines(root, ['smoke/shots/']);
    if (state.step === 'handoff') {
      try { require('./context-snapshot.cjs').writeContext(root); } catch {}
    }
  }
  record(state, { action: 'next', from, to: state.step });
  if (['coding', 'smoke', 'handoff'].includes(from)) require('./discord-notify.cjs').notify(root, state, `xong bước ${from} — ${L.STEP_LABEL[from]}`, 'phase-done');
  const start = state.step === 'coding' ? plansToStart(root, state).map(p => p.id) : [];
  const result = { ok: true, from, step: state.step, start, done: Boolean(state.done) };
  if (debt) result.debt = debt;
  if (reopened.length) Object.assign(result, { reopened, tell: `nói PO một câu: plan đã gộp ${reopened.join(', ')} phải viết lại vì plan hoặc spec đổi` });
  return result;
}

function goBack(root, state, to, reason, planId, self = false, byService = false) {
  const from = state.step;
  if (!reason) return { ok: false, error: 'Cần --reason: vì sao phải quay lại' };
  if (!L.STEPS.includes(to)) return { ok: false, error: `Bước không hợp lệ: ${to}` };
  if (!L.canGoBack(from, to)) return { ok: false, error: `Không được quay từ ${from} về ${to}. Được phép: ${[...(L.BACK_EDGES[from] || []), 'spec'].join(', ')}` };
  if (self && (to !== 'clear' || state.gates.g1.status !== 'approved')) return { ok: false, error: '--self chỉ dùng cho back --to clear sau khi cổng 1 đã duyệt (trợ lý tự đổi spec, cổng 1 giữ nguyên)' };
  const key = L.loopKey(from, to);
  const used = (state.loops || {})[key] || 0;
  const limit = from === 'smoke' && to === 'coding' ? L.SMOKE_LOOP_LIMIT : L.LOOP_LIMIT;
  if (!byService && used >= limit) return { ok: false, exhausted: true, error: `Đã quay lại ${from} → ${to} ${limit} lần. Dừng lại, tóm tắt cho PO và đề nghị nhờ dev.` };

  const target = to === 'coding' ? planId : null;
  if (to === 'coding') {
    if (!target) return { ok: false, error: 'Cần --plan <id> để biết plan nào phải sửa' };
    if (!readPlans(root).some(p => p.id === target)) return { ok: false, error: `Không có plan ${target}` };
  }
  const drop = Object.entries(state.plans || {})
    .filter(([id, p]) => p.worktree && (!target || id === target))
    .map(([id, p]) => ({ plan: id, worktree: p.worktree, branch: p.branch }));
  if (target) reopenPlan(root, state, target, 'back');
  if (target && byService) reopenFeatures(root, state, target);
  for (const d of drop) if (d.plan !== target) reopenPlan(root, state, d.plan, 'worktree-dropped');
  const redone = [
    ...JUDGED_STEPS.filter(step => L.stepIndex(step) >= L.stepIndex(to)),
    ...(target ? [`review:${target}`] : []),
  ];
  clearVerdicts(root, redone);
  state.judgeFails = Object.fromEntries(Object.entries(state.judgeFails || {}).filter(([key]) => !redone.includes(key) || /^review:/.test(key)));
  for (const gate of L.gatesReopenedBy(to)) if (!(self && gate === 'g1')) state.gates[gate] = { status: 'pending' };
  if (self) {
    const versions = specVersions(root);
    const latest = versions[versions.length - 1];
    state.selfSpecChanges = [...(state.selfSpecChanges || []), { at: new Date().toISOString(), from: `spec-v${latest}.md`, to: `spec-v${latest + 1}.md`, why: reason }];
  }
  state.done = false;
  const kept = to === 'spec' ? Object.fromEntries(Object.entries(state.loops || {}).filter(([k]) => k.endsWith('>spec'))) : state.loops || {};
  state.loops = byService ? kept : { ...kept, [key]: used + 1 };
  state.step = to;
  record(state, { action: 'back', from, to, reason, plan: target, ...(self ? { self: true } : {}), ...(byService ? { byService: true } : {}) });
  return { ok: true, from, step: to, plan: target, drop, loop: byService ? used : used + 1, limit, ...(self ? { self: true } : {}) };
}

module.exports = { advance, goBack, gateDue, GATE_NAME };
