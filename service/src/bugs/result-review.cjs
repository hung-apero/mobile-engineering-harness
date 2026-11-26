const { fail, requireObject, requireList, oneOf, textOf, matching, parseJson, lastJsonBlock, attempt, TEXT_MAX } = require('./result-fields.cjs');

const VERDICTS = ['approve', 'changes'];
const SEVERITIES = ['blocker', 'major', 'minor'];
const COMMIT = /^[0-9a-f]{7,40}$/;
const LANE_FIELDS = ['branch', 'verdict', 'specMatch', 'needsPo', 'reversesIntentional', 'forbidden', 'findings'];

const string = { type: 'string', minLength: 1, maxLength: TEXT_MAX };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const list = items => ({ type: 'array', items });

const REVIEW_SCHEMA = object({
  lanes: list(object({
    branch: string,
    verdict: { type: 'string', enum: VERDICTS },
    specMatch: { type: 'boolean' },
    needsPo: list(object({ key: string, question: string })),
    reversesIntentional: list(object({ key: string, commit: { type: 'string', pattern: COMMIT.source }, why: string })),
    forbidden: list(string),
    findings: list(object({ file: string, line: { type: 'integer', minimum: 0 }, severity: { type: 'string', enum: SEVERITIES }, text: string })),
  })),
});

function readFinding(value, where) {
  requireObject(value, ['file', 'line', 'severity', 'text'], where);
  if (!Number.isInteger(value.line) || value.line < 0) fail(`${where}: line phải là số nguyên không âm`);
  return {
    file: textOf(value.file, `${where}: file`),
    line: value.line,
    severity: oneOf(value.severity, SEVERITIES, `${where}: severity`),
    text: textOf(value.text, `${where}: text`),
  };
}

function settleVerdict(lane) {
  const blocked = lane.forbidden.length > 0 || lane.findings.some(f => f.severity === 'blocker') || (!lane.specMatch && lane.needsPo.length === 0);
  return blocked ? { ...lane, verdict: 'changes' } : lane;
}

function readLane(value, expected) {
  requireObject(value, LANE_FIELDS, 'lane');
  const branch = oneOf(value.branch, expected.map(l => l.branch), 'branch');
  const { keys } = expected.find(l => l.branch === branch);
  const read = (name, fields, readItem) => requireList(value[name], `${branch}: ${name}`).map(item => {
    const where = `${branch}: ${name}`;
    requireObject(item, fields, where);
    return { key: oneOf(item.key, keys, `${where}.key`), ...readItem(item, where) };
  });
  const verdict = oneOf(value.verdict, VERDICTS, `${branch}: verdict`);
  if (typeof value.specMatch !== 'boolean') fail(`${branch}: specMatch phải là true hoặc false`);
  return settleVerdict({
    branch,
    verdict,
    specMatch: value.specMatch,
    needsPo: read('needsPo', ['key', 'question'], (item, where) => ({ question: textOf(item.question, `${where}.question`) })),
    reversesIntentional: read('reversesIntentional', ['key', 'commit', 'why'], (item, where) => ({
      commit: matching(item.commit, COMMIT, `${where}.commit`),
      why: textOf(item.why, `${where}.why`),
    })),
    forbidden: requireList(value.forbidden, `${branch}: forbidden`).map(text => textOf(text, `${branch}: forbidden`)),
    findings: requireList(value.findings, `${branch}: findings`).map(item => readFinding(item, `${branch}: findings`)),
  });
}

function documentOf(input) {
  if (typeof input !== 'string') return input;
  return lastJsonBlock(input) ?? parseJson(input);
}

function parseReview(input, { lanes: expected } = {}) {
  if (!Array.isArray(expected) || expected.length === 0) throw new TypeError('lanes phải là danh sách không rỗng');
  if (!expected.every(l => Array.isArray(l.keys) && l.keys.length > 0)) throw new TypeError('mỗi lane phải có keys');
  return attempt(() => {
    const doc = requireObject(documentOf(input), ['lanes'], 'JSON');
    const found = new Map();
    for (const value of requireList(doc.lanes, 'lanes')) {
      const lane = readLane(value, expected);
      if (found.has(lane.branch)) fail(`${lane.branch}: trùng lane`);
      found.set(lane.branch, lane);
    }
    return { lanes: expected.map(({ branch }) => found.get(branch) ?? fail(`thiếu lane ${branch}`)) };
  });
}

module.exports = { parseReview, REVIEW_SCHEMA };
