const fs = require('fs');
const path = require('path');
const { DIR, writeJsonAtomic, ensureIgnoredLines } = require('./learn-app-state.cjs');
const L = require('./looper-steps.cjs');
const { file, read, mtime, specVersions, openQuestions, readPlans } = require('./looper-parse.cjs');

const CONFIG = 'inputs/headless.json';
const BLOCKED = 'headless-blocked.json';
const SEGMENTS = ['ask', 'clarify', 'build'];
const FIGMA_URL = /^https:\/\/(www\.)?figma\.com\/(design|file)\/[A-Za-z0-9]+/;

function isHeadless(env = process.env) {
  return env.LEARN_APP_HEADLESS === '1';
}

function readConfig(root) {
  try {
    const config = JSON.parse(read(root, CONFIG) || 'null');
    return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
  } catch {
    return null;
  }
}

function figmaProblem(figma) {
  if (figma === undefined) return `${CONFIG}: thiếu figma — { "url": "<link>" }, hoặc null khi spec không có design`;
  if (figma === null || (typeof figma === 'object' && FIGMA_URL.test(String(figma.url)))) return null;
  return `${CONFIG}: figma phải là { "url": "https://www.figma.com/design/<key>/…" } hoặc null`;
}

function inputProblem(root, rel, key, pattern) {
  if (typeof rel !== 'string' || !pattern.test(rel)) return `${CONFIG}: ${key} phải là đường dẫn trong .learn-app/inputs/`;
  return fs.existsSync(file(root, rel)) ? null : `chưa có ${rel} (${CONFIG}: ${key})`;
}

function reworkFiles(root) {
  const { rework } = readConfig(root) || {};
  return Array.isArray(rework) ? rework : [];
}

function configProblems(root) {
  const config = readConfig(root);
  if (!config) return [`chưa có ${CONFIG} hoặc không phải JSON hợp lệ`];
  return [
    SEGMENTS.includes(config.segment) ? null : `${CONFIG}: segment phải là ${SEGMENTS.join('|')}`,
    /^[A-Za-z0-9_-]+$/.test(String(config.app || '')) ? null : `${CONFIG}: thiếu app (mã app)`,
    ['existing', 'new'].includes(config.case) ? null : `${CONFIG}: case phải là existing|new`,
    inputProblem(root, config.spec, 'spec', /^inputs\/spec-v\d+\.md$/),
    figmaProblem(config.figma),
    config.notes === undefined || config.notes === null ? null : inputProblem(root, config.notes, 'notes', /^inputs\/[\w-]+\.md$/),
    ...(config.rework === undefined ? [] : Array.isArray(config.rework) ? config.rework.map(rel => inputProblem(root, rel, 'rework', /^inputs\/rework-\d+\.md$/)) : [`${CONFIG}: rework phải là danh sách file`]),
  ].filter(Boolean);
}

function readBlocked(root) {
  try {
    return JSON.parse(read(root, BLOCKED) || 'null');
  } catch {
    return null;
  }
}

function writeBlocked(root, { step, reason, missing = [] }) {
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  ensureIgnoredLines(root, [BLOCKED]);
  const blocked = { step, reason, missing, at: new Date().toISOString() };
  writeJsonAtomic(file(root, BLOCKED), blocked);
  return blocked;
}

function clearBlocked(root) {
  fs.rmSync(file(root, BLOCKED), { force: true });
}

function segmentStop(root, state) {
  const config = readConfig(root);
  const segment = config && config.segment;
  if (!SEGMENTS.includes(segment)) return `${CONFIG} thiếu hoặc sai segment`;
  const at = L.stepIndex(state.step);
  const approved = state.gates.g1.status === 'approved';
  if (segment === 'ask') {
    if (at < L.stepIndex('clear')) return null;
    const open = openQuestions(root);
    return open.length ? `đoạn ask xong: có ${open.length} câu hỏi chờ PO trả lời` : 'đoạn ask xong: không có câu hỏi nào chờ PO';
  }
  if (segment === 'clarify') {
    if (at >= L.stepIndex('planning')) return 'đoạn clarify xong: cổng 1 đã duyệt';
    const blocking = state.step === 'clear' ? openQuestions(root).filter(q => q.blocking).map(q => q.id) : [];
    return blocking.length ? `đoạn clarify dừng: câu [chặn] chưa có câu trả lời ${blocking.join(', ')}` : null;
  }
  return approved ? null : 'đoạn build dừng: cổng 1 chưa được duyệt';
}

function headlessStop(root, state) {
  const blocked = readBlocked(root);
  if (blocked && blocked.step === state.step) return `bị chặn ở bước ${state.step}: ${blocked.reason}`;
  return segmentStop(root, state);
}

function notesProblems(root) {
  const { notes } = readConfig(root) || {};
  const versions = specVersions(root);
  if (!notes || !fs.existsSync(file(root, notes)) || !versions.length) return [];
  const latest = `inputs/spec-v${versions[versions.length - 1]}.md`;
  return mtime(root, latest) < mtime(root, notes) ? [`${latest} cũ hơn góp ý của PO (${notes}) — spec-clear Mode: update với PO notes:`] : [];
}

function reworkProblems(root) {
  const asked = reworkFiles(root).filter(rel => fs.existsSync(file(root, rel)));
  const plans = readPlans(root);
  if (!asked.length || !plans.length) return [];
  const newest = Math.max(...plans.map(p => mtime(root, `plans/${p.file}`)));
  const ahead = asked.filter(rel => mtime(root, rel) > newest);
  return ahead.length ? [`các plan cũ hơn yêu cầu làm lại ${ahead.join(', ')} — gọi planner với Feedback: = nguyên văn các file đó`] : [];
}

function stepProblems(root, state, step) {
  if (!isHeadless()) return [];
  if (step === 'spec') {
    const config = readConfig(root) || {};
    const noDesign = config.figma !== null && fs.existsSync(file(root, 'inputs/no-design'));
    return [...configProblems(root), ...(noDesign ? [`inputs/no-design chỉ được có khi ${CONFIG} ghi figma: null`] : [])];
  }
  if (step === 'ask') return require('./triage.cjs').triageProblems(root, state);
  if (step === 'planning') return reworkProblems(root);
  return step === 'update-spec' ? notesProblems(root) : [];
}

function reopensApprovedGate(state, to, self) {
  return L.STEPS.includes(to) && L.gatesReopenedBy(to).some(gate => state.gates[gate].status === 'approved' && !(self && gate === 'g1'));
}

function decideHeadlessShell(command, env = process.env) {
  if (!isHeadless(env)) return null;
  if (/LEARN_APP_HEADLESS|\benv\s+-i?\s/.test(command)) return 'Đang chạy không người: không được đổi hay bỏ LEARN_APP_HEADLESS.';
  if (/(^|[;&|(\n]\s*)(\/usr\/bin\/)?(open|xdg-open)\s+(-|\S*[./])/.test(command)) return 'Đang chạy không người: không mở trang hay file bằng open.';
  return null;
}

module.exports = { CONFIG, BLOCKED, SEGMENTS, isHeadless, readConfig, reworkFiles, configProblems, readBlocked, writeBlocked, clearBlocked, segmentStop, headlessStop, stepProblems, reopensApprovedGate, decideHeadlessShell };
