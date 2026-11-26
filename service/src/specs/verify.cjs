const files = require('./repo-files.cjs');
const { parseQuestions } = require('./questions.cjs');
const { mergeTriage } = require('./triage.cjs');
const { redact, firstLine } = require('../redact.cjs');

const GATES = { g1: /^cần PO duyệt cổng 1\b/, g3: /^cần PO duyệt cổng 3\b/ };
const DEV = /preflight|token|quyền|đăng nhập|mcp|\b40[13]\b|cài|mạng|vpn|repo|gradle|google-services|keystore|sdk|quay lui/i;
const PO = /\bPO\b|spec|thiết kế|design|figma|nội dung|góp ý/i;

const line = (text, max = 300) => redact(String(text ?? '').replace(/[\p{C}\s]+/gu, ' ').trim()).slice(0, max).toWellFormed();

function blockedOf(repo) {
  if (files.read(repo, 'headless-blocked.json') === null) return null;
  const found = files.readJson(repo, 'headless-blocked.json') ?? {};
  const reason = line(found.reason) || 'worker dừng, không ghi rõ lý do';
  const missing = (Array.isArray(found.missing) ? found.missing : []).slice(0, 10).map(item => line(item, 120)).filter(Boolean);
  const text = [reason, ...missing].join(' ');
  return { type: 'blocked', kind: line(found.step, 20) || 'spec', role: !DEV.test(text) && PO.test(text) ? 'po' : 'dev', reason, missing };
}

const short = reason => ({ type: 'short', reason });

async function atGate(run, repo, gate = 'g1') {
  let out;
  try {
    out = await run.ctx.specs.runState(run.project, repo, ['next']);
  } catch (error) {
    return firstLine(error);
  }
  const { code, stdout, stderr } = out;
  let missing = null;
  try {
    missing = JSON.parse(stdout).missing;
  } catch {}
  if (code === 2 && Array.isArray(missing) && missing.length === 1 && GATES[gate].test(missing[0])) return null;
  return line(Array.isArray(missing) ? missing.join('; ') : stderr || `next trả mã ${code}`, 500);
}

function unseenForPo(spec, md) {
  const shown = new Set((spec.data.rounds ?? []).flatMap(round => [...round.ask, ...round.auto]));
  return mergeTriage(parseQuestions(md), files.readJson(spec.data.repo, 'triage.json')).some(q => !q.answered && !shown.has(q.id) && q.mode === 'ask');
}

async function inspect(run) {
  const { repo, segment } = run.spec.data;
  const state = files.readJson(repo, 'state.json');
  if (state && state.gates?.g1?.status !== 'pending') return { type: 'tampered', reason: 'worker đã đổi trạng thái cổng 1' };
  const blocked = blockedOf(repo);
  if (blocked) return blocked;
  if (!state) return short('chưa có state.json');
  const stop = segment.name === 'ask' ? ['clear'] : ['clear', 'update-spec'];
  if (!stop.includes(state.step)) return short(`đang ở bước ${line(state.step, 20)}`);
  const md = files.read(repo, 'questions.md');
  if (md === null) return short('chưa có questions.md');
  if (segment.name === 'ask') return { type: 'questions', md };
  if (unseenForPo(run.spec, md)) return { type: 'questions', md };
  if (state.step === 'clear') {
    const open = parseQuestions(md).filter(q => q.blocking && !q.answered);
    return open.length ? { type: 'questions', md } : short('còn ở bước clear');
  }
  const problem = await atGate(run, repo);
  if (problem) return short(problem);
  const latest = files.latestSpec(repo);
  if (!latest || latest.version <= (run.spec.data.reviewFloor ?? 1)) return short('chưa có bản spec đã làm rõ mới');
  return { type: 'clarified', md, latest };
}

module.exports = { inspect, blockedOf, atGate, line };
