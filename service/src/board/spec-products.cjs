const { progressOf } = require('../specs/build-result.cjs');
const { timeOf } = require('./bug-groups.cjs');

const BUILT = new Set(['building', 'smoking', 'uidiff', 'reviewing', 'candidate', 'po-trial', 'landing']);

function questionLine(data) {
  const questions = Array.isArray(data.questions) ? data.questions : [];
  if (!questions.length) return null;
  const answers = Object.values(data.answered ?? {});
  const asked = questions.filter(question => question.mode !== 'auto').length;
  const byPo = answers.filter(answer => answer?.kind === 'po').length;
  const byAgent = questions.length - asked;
  return `${questions.length} câu hỏi: ${byPo}/${asked} câu PO đã trả lời${byAgent ? `, ${byAgent} câu agent tự chốt` : ''}`;
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
  const data = spec.data ?? {};
  const references = Array.isArray(data.references) && data.references.length ? `${data.references.length} tài liệu tham chiếu` : null;
  return [questionLine(data), references, specLine(data, now), codeLine(spec), installLine(data.build, now)].filter(Boolean);
}

module.exports = { productsOf };
