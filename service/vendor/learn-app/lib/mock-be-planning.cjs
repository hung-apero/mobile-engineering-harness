const { read, specVersions } = require('./looper-parse.cjs');
const { contractProblems } = require('./mock-be-contract.cjs');

const CONTRACT = 'api-contract.json';

function mockSection(specText) {
  const found = /^## Dữ liệu mẫu \(mock\)[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(specText || '');
  return found ? found[1] : null;
}

function consentQuote(section) {
  const found = /^- PO đồng ý \([^)]*\): "([^"]+)"/m.exec(section || '');
  return found ? found[1].trim() : null;
}

function poConsent(section, questionsText) {
  const quote = consentQuote(section);
  if (!quote) return false;
  return (questionsText || '').split('\n').some(line => /^- \*\*PO trả lời/.test(line) && line.includes(quote));
}

function coversCms(section) {
  return /^- Phủ:.*\bCMS\b/m.test(section || '');
}

function probeResult(root) {
  try {
    return JSON.parse(read(root, 'backend-probe.json') || 'null');
  } catch {
    return null;
  }
}

function contractCheck(root) {
  const text = read(root, CONTRACT);
  if (text === null) return null;
  try {
    return contractProblems(JSON.parse(text)).map(problem => `${CONTRACT}: ${problem}`);
  } catch (error) {
    return [`${CONTRACT} không đọc được: ${error.message}`];
  }
}

function mockPlanProblems(root, plans) {
  const versions = specVersions(root);
  const latest = versions[versions.length - 1];
  const section = latest ? mockSection(read(root, `inputs/spec-v${latest}.md`)) : null;
  const consent = poConsent(section, read(root, 'questions.md'));
  const mocks = plans.filter(p => p.kind === 'mock-be');
  const missing = [];
  if (mocks.length && !consent) missing.push('plan mock-be chưa có PO xác nhận — spec đã làm rõ thiếu mục "## Dữ liệu mẫu (mock)" với dòng `- PO đồng ý (Q<n>, <ngày>): "<nguyên văn>"`; không có thì bỏ plan mock-be, ghi plan là chờ hệ thống thật');
  if (section !== null && !consent) missing.push('mục "## Dữ liệu mẫu (mock)" thiếu dòng `- PO đồng ý (Q<n>, <ngày>): "<nguyên văn>"` chép đúng từ một dòng **PO trả lời** trong questions.md');
  const probe = probeResult(root);
  if (section !== null && coversCms(section) && !(probe && probe.cms === 'empty')) missing.push(`dữ liệu mẫu chỉ được phủ CMS khi backend-probe.json báo CMS dev rỗng (đang: ${probe ? probe.cms : 'chưa probe'}) — dùng CMS thật`);
  if (consent && !mocks.length) missing.push('spec có mục "## Dữ liệu mẫu (mock)" mà chưa có plan kind: mock-be');
  const contract = contractCheck(root);
  if (consent && contract === null) missing.push(`chưa có ${CONTRACT} (route + schema cho dữ liệu mẫu)`);
  if (contract) missing.push(...contract);
  return missing;
}

module.exports = { mockSection, consentQuote, poConsent, mockPlanProblems };
