const { read, manifestFeatures, manifestBom, questionBlocks, parseList } = require('./looper-parse.cjs');
const { agentAnswers } = require('./agent-answers.cjs');
const { fail } = require('./cli-io.cjs');
const { readTrace } = require('./manifest-trace.cjs');

function cell(value) {
  return String(value).replace(/\|/g, '\\|');
}

function agentLines(questions) {
  const answers = agentAnswers(questions);
  if (!answers.length) return [];
  return ['', `Agent tự chốt (${answers.length} câu, PO chưa chọn — đổi được):`, '', '| Câu | Agent chọn | Nguồn |', '|---|---|---|', ...answers.map(a => `| ${cell(a.title)} | ${cell(a.label)} | ${cell(a.source)} |`)];
}

function answerOf(block) {
  const [agent] = agentAnswers(block.text);
  if (agent) return `${agent.label} — Agent tự chốt`;
  const line = (block.text || '').split('\n').find(l => /\*\*PO (trả lời|chọn)/.test(l));
  if (!line) return '';
  return line.replace(/^\s*-\s*/, '').replace(/\*\*/g, '').replace(/^PO (trả lời|chọn)\s*(\([^)]*\))?\s*:?\s*/, '').replace(/\s*—\s*nguyên văn:.*$/, '').trim();
}

function decidedBy(feature, blocks) {
  if (feature.decided_by === undefined || (feature.decided_by !== null && typeof feature.decided_by === 'object' && !Array.isArray(feature.decided_by))) return ['(chưa ghi decided_by trong manifest-trace.yaml)'];
  const declared = parseList(feature.decided_by);
  return blocks.filter(b => declared.includes(b.id)).map(b => `${b.id} (${answerOf(b) || 'chưa trả lời'})`);
}

function summaryLines(root) {
  const manifest = read(root, 'app-manifest.yaml');
  if (manifest === null) fail('Chưa có app-manifest.yaml — chạy spec-clear Mode: update trước');
  const questions = read(root, 'questions.md') || '';
  const blocks = questionBlocks(questions).map((b, index) => ({ ...b, text: questions.split(/^(?=## Q\d+\b)/m).filter(t => /^## Q\d+\b/.test(t))[index] }));
  const trace = readTrace(root);
  const features = manifestFeatures(manifest).map(f => (trace ? { ...f, decided_by: trace.decidedBy[f.id] } : f));
  const bom = manifestBom(manifest);
  const rows = features.map(f => {
    const from = f.source === 'app' ? `app tự viết (module ${f.module || `feature-${f.id}`})` : `lấy từ Feature Store: ${f.catalog || f.id}${f.version ? ` bản ${f.version}` : ''}`;
    const why = decidedBy(f, blocks);
    return `| ${f.id} | ${from} | ${why.length ? why.join(', ') : '—'} |`;
  });
  return [
    `Thư viện Learn (BOM): ${bom || 'chưa ghi'}`,
    '',
    '| Tính năng | Lấy từ đâu | Câu trả lời quyết định |',
    '|---|---|---|',
    ...rows,
    '',
    `${features.filter(f => f.source !== 'app').length} tính năng lấy từ Store, ${features.filter(f => f.source === 'app').length} tính năng app tự viết.`,
    ...agentLines(questions),
  ];
}

function manifestSummary(root) {
  console.log(summaryLines(root).join('\n'));
}

module.exports = { manifestSummary, summaryLines };
