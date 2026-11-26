const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');
const { parseYaml } = require('./manifest-yaml.cjs');

const TRACE = 'manifest-trace.yaml';
const STATUSES = ['planned', 'done', 'missing'];

function readTrace(root) {
  const file = path.join(root, DIR, TRACE);
  if (!fs.existsSync(file)) return null;
  let trace;
  try { trace = parseYaml(fs.readFileSync(file, 'utf8')) || {}; } catch (error) {
    return { error: `${TRACE} không đọc được: ${error.message}`, decidedBy: {}, changes: [] };
  }
  return { decidedBy: trace.decided_by && typeof trace.decided_by === 'object' ? trace.decided_by : {}, changes: [].concat(trace.changes || []) };
}

function traceProblems(trace, featureIds) {
  if (!trace) return [`chưa có .learn-app/${TRACE} (decided_by của từng feature và changes)`];
  if (trace.error) return [trace.error];
  const problems = [];
  const missing = featureIds.filter(id => !(id in trace.decidedBy));
  if (missing.length) problems.push(`${TRACE} thiếu decided_by ở: ${missing.join(', ')} (ghi [] nếu không câu trả lời nào quyết định)`);
  const notList = featureIds.filter(id => id in trace.decidedBy && !Array.isArray(trace.decidedBy[id]));
  if (notList.length) problems.push(`${TRACE} decided_by phải là danh sách [Q..] ở: ${notList.join(', ')}`);
  for (const c of trace.changes) {
    const label = (c && c.change) || JSON.stringify(c);
    if (!c || typeof c !== 'object' || !c.at) problems.push(`${TRACE} changes: "${label}" chưa ghi at (chỗ nào trong app-manifest.yaml)`);
    else if (!c.change) problems.push(`${TRACE} changes ở ${c.at}: chưa ghi change (đổi gì)`);
    else if (!c.by || (Array.isArray(c.by) && !c.by.length)) problems.push(`${TRACE} changes: "${label}" chưa ghi by (mục spec § / câu Q nào yêu cầu)`);
    else if (!STATUSES.includes(c.status)) problems.push(`${TRACE} changes: "${label}" status phải là ${STATUSES.join(' | ')}`);
  }
  return problems;
}

module.exports = { TRACE, readTrace, traceProblems };
