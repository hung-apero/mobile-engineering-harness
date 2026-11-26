const fs = require('fs');
const path = require('path');
const { DIR, writeJsonAtomic, readState } = require('./learn-app-state.cjs');
const L = require('./looper-steps.cjs');
const { checkStep } = require('./looper-checks.cjs');
const { openQuestions } = require('./looper-parse.cjs');
const H = require('./headless.cjs');
const P = require('./plan-schedule.cjs');
const { runningPlans } = P;
const { ensureIgnored, progressHash, readOr, planActivity } = require('./progress-hash.cjs');

const MAX_NUDGES = 3;
const ASYNC_AGENT_STEPS = new Set(['scout', 'ask', 'update-spec', 'planning', 'reviewing', 'smoke']);
const MAX_NUDGES_ASYNC = 10;
const PO_LINE = /cần PO duyệt|hỏi PO|chờ PO/;

function nudgeLimit(state) {
  return ASYNC_AGENT_STEPS.has(state.step) ? MAX_NUDGES_ASYNC : MAX_NUDGES;
}

function autopilotFile(root) {
  return path.join(root, DIR, 'autopilot.json');
}

function readAutopilot(root) {
  try {
    return JSON.parse(fs.readFileSync(autopilotFile(root), 'utf8'));
  } catch {
    return {};
  }
}

function readOwner(root) {
  return readAutopilot(root).owner || null;
}

// The orchestrator is the one session that drives the pipeline through the state CLI; a teammate pane or subagent
// never runs it (scout/ui-node-writer have no Bash; plan-reviewer/judge run only `verdict`, which activity.cjs
// excludes), so claiming on that command cannot be stolen and a resumed session reclaims on its first command.
function claimOwner(root, sessionId) {
  if (!sessionId) return;
  const saved = readAutopilot(root);
  if (saved.owner && saved.owner.sessionId === sessionId) return;
  ensureIgnored(root);
  saveAutopilot(root, { ...saved, owner: { sessionId, at: new Date().toISOString() } });
}

function isForeignSession(sessionId, owner) {
  return Boolean(owner && owner.sessionId && sessionId && sessionId !== owner.sessionId);
}

function setWaiting(root, step) {
  const saved = readAutopilot(root);
  ensureIgnored(root);
  saveAutopilot(root, { ...saved, waitingAgents: { step, at: new Date().toISOString() } });
}

function clearWaiting(root) {
  const saved = readAutopilot(root);
  if (!saved.waitingAgents) return;
  delete saved.waitingAgents;
  saveAutopilot(root, saved);
}

const CHAIN_QUIET_MS = 10 * 60 * 1000;

function busyChains(root, state, now) {
  return runningPlans(state).filter(id => {
    const plan = state.plans[id];
    return plan.status !== 'reviewed' && now - planActivity(root, id, plan.worktree) < CHAIN_QUIET_MS;
  });
}

function stopReason(root, state, now = Date.now()) {
  if (state.done) return 'đã xong';
  const headless = H.isHeadless();
  const headlessStop = headless ? H.headlessStop(root, state) : null;
  if (headlessStop) return headlessStop;
  if (!headless && state.step === 'spec') return 'bước spec: cần PO đưa spec, Figma, mã app';
  if (!headless && state.step === 'clear' && state.gates.g1.status !== 'approved') {
    const open = openQuestions(root);
    const blocking = open.filter(q => q.blocking).length;
    return open.length ? `có ${open.length} câu hỏi chờ PO trả lời${blocking ? ` (${blocking} câu [chặn])` : ''}` : 'bước clear: PO trả lời câu hỏi';
  }
  const missing = checkStep(root, state, state.step);
  const fails = key => ((state.judgeFails || {})[key] || 0) >= 3;
  const judged = fails(state.step) && missing.some(m => m.startsWith('chấm không đạt')) ? state.step : null;
  if (judged) return `${judged} chấm không đạt 3 lần — hỏi PO chấp nhận hay nhờ dev`;
  const gate = L.GATE_AT[state.step];
  if (gate && state.gates[gate].status !== 'approved' && missing.every(m => PO_LINE.test(m))) return `chờ PO duyệt cổng ${gate.slice(1)}`;
  if (state.step !== 'coding' && missing.length) {
    const wait = readAutopilot(root).waitingAgents;
    if (wait && wait.step === state.step && now - Date.parse(wait.at) < CHAIN_QUIET_MS) return `đang chờ agent nền bước ${state.step} — agent xong sẽ gọi lại`;
  }
  const busy = state.step === 'coding' ? busyChains(root, state, now) : [];
  const idle = state.step === 'coding' && P.plansToStart(root, state).length === 0 && !runningPlans(state).some(id => state.plans[id].status === 'reviewed');
  if (busy.length && idle) return `đang chờ agent của plan ${busy.join(', ')} chạy nền — agent xong sẽ gọi lại`;
  return null;
}

function nextHint(root, state) {
  let first = null;
  try {
    const open = checkStep(root, state, state.step).filter(m => !PO_LINE.test(m));
    first = (state.step === 'coding' ? open.slice(0, 4).join(' · ') : open[0]) || null;
  } catch {}
  const running = state.step === 'coding' ? runningPlans(state) : [];
  return [
    `Chưa cần PO. Bước ${state.step} — ${L.STEP_LABEL[state.step]}${running.length ? `, đang làm: ${running.join(', ')}` : ''}.`,
    first ? `Việc còn thiếu: ${first}.` : null,
    'Làm tiếp theo skill learn-app rồi learn-app-state.cjs next. Chỉ báo PO một dòng tiến độ, không hỏi.',
    H.isHeadless() ? 'Đang chạy không người: cần người → learn-app-state.cjs headless-block --reason "…" --missing "a; b" rồi dừng, không hỏi.' : 'Cần hỏi PO ở chỗ khác (preflight lỗi, chưa biết branch mở PR, gh chưa đăng nhập…) → learn-app-state.cjs wait-po --reason "…" rồi hỏi.',
  ].filter(Boolean).join(' ');
}

function saveAutopilot(root, data) {
  writeJsonAtomic(autopilotFile(root), data);
}

// The nudge counter is reset on every decision, but the owner claim and the background-wait marker outlive it.
function persistCounters(root, saved, fields) {
  const keep = {};
  if (saved.owner) keep.owner = saved.owner;
  if (saved.waitingAgents) keep.waitingAgents = saved.waitingAgents;
  saveAutopilot(root, { ...keep, ...fields });
}

function stopKind(why) {
  if (/^đã xong/.test(why)) return 'done';
  if (/^đang chờ agent/.test(why)) return 'idle-background';
  if (/^kẹt/.test(why)) return 'stuck';
  return 'po-wait';
}

function noteStop(root, state, result) {
  if (!result.stop) return result;
  try { require('./discord-notify.cjs').notify(root, state, result.why, stopKind(result.why)); } catch {}
  return result;
}

function decide(root, state, now = Date.now()) {
  return noteStop(root, state, decideStop(root, state, now));
}

function decideStop(root, state, now) {
  ensureIgnored(root);
  const saved = readAutopilot(root);
  const hash = progressHash(root);
  if (saved.waitPO && saved.waitPO.hash === hash) return { stop: true, why: `chờ PO: ${saved.waitPO.reason}` };
  const why = stopReason(root, state, now);
  const nudges = saved.hash === hash ? saved.nudges || 0 : 0;
  if (why) {
    persistCounters(root, saved, { hash, nudges: 0 });
    return { stop: true, why };
  }
  const limit = nudgeLimit(state);
  if (nudges >= limit) {
    persistCounters(root, saved, { hash, nudges: limit });
    const stuck = `kẹt ở bước ${state.step}: ${limit} lần nhắc làm tiếp mà không có gì đổi`;
    if (H.isHeadless()) H.writeBlocked(root, { step: state.step, reason: stuck, missing: checkStep(root, state, state.step) });
    return { stop: true, why: stuck };
  }
  persistCounters(root, saved, { hash, nudges: nudges + 1 });
  const last = nudges + 1 === limit ? ' Lần nhắc cuối: nếu thật sự không làm tiếp được, báo PO đã thử gì và vì sao kẹt, đề nghị nhờ dev, rồi dừng.' : '';
  return { stop: false, reason: nextHint(root, state) + last };
}

function waitPO(root, reason) {
  if (!reason) throw new Error('Cần --reason: vì sao phải hỏi PO');
  ensureIgnored(root);
  if (H.isHeadless()) H.writeBlocked(root, { step: readState(root).step, reason });
  const saved = { ...readAutopilot(root), waitPO: { reason, hash: progressHash(root), at: new Date().toISOString() } };
  saveAutopilot(root, saved);
  return saved.waitPO;
}

module.exports = { stopKind, MAX_NUDGES, MAX_NUDGES_ASYNC, ASYNC_AGENT_STEPS, nudgeLimit, stopReason, nextHint, decide, waitPO, readAutopilot, readOwner, claimOwner, isForeignSession, setWaiting, clearWaiting };
