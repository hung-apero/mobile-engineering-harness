const files = require('./repo-files.cjs');
const { parseQuestions } = require('./questions.cjs');
const { mergeTriage } = require('./triage.cjs');
const { redact } = require('../redact.cjs');

const DEV = /preflight|token|quyền|đăng nhập|mcp|\b40[13]\b|cài|mạng|vpn|repo|gradle|google-services|keystore|sdk|quay lui/i;
const PO = /\bPO\b|spec|thiết kế|design|figma|nội dung|góp ý/i;

const line = (text, max = 300) => redact(String(text ?? '').replace(/[\p{C}\s]+/gu, ' ').trim()).slice(0, max).toWellFormed();

function blockedOf(repo, name = 'blocked.json') {
  if (files.read(repo, name) === null) return null;
  const found = files.readJson(repo, name) ?? {};
  const reason = line(found.reason) || 'worker dừng, không ghi rõ lý do';
  const missing = (Array.isArray(found.missing) ? found.missing : []).slice(0, 10).map(item => line(item, 120)).filter(Boolean);
  const text = [reason, ...missing].join(' ');
  return { type: 'blocked', kind: line(found.segment ?? found.step, 20) || 'spec', role: !DEV.test(text) && PO.test(text) ? 'po' : 'dev', reason, missing };
}

const short = reason => ({ type: 'short', reason });

function unseen(spec, md, modes = ['ask', 'auto']) {
  const shown = new Set((spec.data.rounds ?? []).flatMap(round => [...round.ask, ...round.auto]));
  return mergeTriage(parseQuestions(md), files.readJson(spec.data.repo, 'triage.json')).some(q => !q.answered && !shown.has(q.id) && modes.includes(q.mode));
}

async function inspect(run) {
  const { repo, segment } = run.spec.data;
  if (segment.inputsSha && files.inputsSha(repo) !== segment.inputsSha) return { type: 'tampered', reason: 'worker đã sửa .harness-run/inputs' };
  const blocked = blockedOf(repo);
  if (blocked) return blocked;
  const checked = await run.ctx.specs.check(run.project, repo, segment.name);
  if (checked.problems.length) return short(line(checked.problems.join('; '), 500));
  const md = files.read(repo, 'questions.md');
  if (md === null) return short('chưa có questions.md');
  if (segment.name === 'ask') return { type: 'questions', md };
  if (unseen(run.spec, md, ['ask'])) return { type: 'questions', md };
  if (parseQuestions(md).some(q => q.blocking && !q.answered)) return { type: 'questions', md };
  const latest = files.latestSpec(repo);
  if (!latest || latest.version <= (run.spec.data.reviewFloor ?? 1)) return unseen(run.spec, md) ? { type: 'questions', md } : short('chưa có bản spec đã làm rõ mới');
  return { type: 'clarified', md, latest };
}

module.exports = { inspect, blockedOf, line };
