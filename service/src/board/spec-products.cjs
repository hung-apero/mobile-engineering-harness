const { progressOf } = require('../specs/build-result.cjs');
const { timeOf } = require('./bug-groups.cjs');

const BUILT = new Set(['building', 'smoking', 'uidiff', 'reviewing', 'candidate', 'po-trial', 'landing']);

const ASKING = new Set(['new', 'reading', 'asking', 'quiz']);

function questionLine(spec) {
  const { data } = spec;
  const questions = Array.isArray(data.questions) ? data.questions : [];
  if (!questions.length) return null;
  const asked = questions.filter(question => question.mode !== 'auto').length;
  const byPo = Object.values(data.answered ?? {}).filter(answer => answer?.kind === 'po').length;
  const open = asked - byPo;
  const rest = open > 0 && (ASKING.has(spec.state) ? `còn ${open} câu chờ PO` : `PO bỏ qua ${open} câu không bắt buộc`);
  const byAgent = questions.length - asked;
  return [`${questions.length} câu hỏi: PO trả lời ${byPo}`, rest, byAgent && `agent tự chốt ${byAgent}`].filter(Boolean).join(', ');
}

function reasonLine(spec) {
  if (spec.state === 'needs-input' && spec.data.needs?.reason) return `Cần bổ sung: ${spec.data.needs.reason}`;
  if (spec.state === 'parked' && spec.data.parked?.reason) return `Tạm gác: ${spec.data.parked.reason}`;
  return null;
}

function specLine(data, now) {
  if (!Number.isInteger(data.reviewVersion)) return null;
  if (Number.isFinite(data.approvedAt)) return `Spec làm rõ v${data.reviewVersion} PO duyệt lúc ${timeOf(data.approvedAt, now)}`;
  return `Spec làm rõ v${data.reviewVersion} chờ PO duyệt`;
}

function codeLine(spec) {
  if (!BUILT.has(spec.state) || typeof spec.data.repo !== 'string') return null;
  try {
    const { done, total } = progressOf(spec.data.repo);
    if (!total) return null;
    const version = spec.data.build?.version;
    return `Code${version ? ` cho bản ${version}` : ''}: ${done}/${total} plan xong`;
  } catch {
    return null;
  }
}

function installLine(build, now) {
  const n = build?.candidate?.n;
  if (!Number.isInteger(n)) return null;
  const sent = Number.isFinite(build.trial?.at) ? ` gửi PO lúc ${timeOf(build.trial.at, now)}` : '';
  return `Bản cài #${n}${sent}${build.trial?.approved ? ', PO đã duyệt' : ''}`;
}

function productsOf(spec, now) {
  const { data } = spec;
  const references = Array.isArray(data.references) && data.references.length ? `${data.references.length} tài liệu tham chiếu` : null;
  return [reasonLine(spec), questionLine(spec), references, specLine(data, now), codeLine(spec), installLine(data.build, now)].filter(Boolean);
}

module.exports = { productsOf };
