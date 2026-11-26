const { fail, requireObject, requireList, oneOf, textOf, parseJson, lastJsonBlock, attempt } = require('../bugs/result-fields.cjs');

const VERDICTS = ['pass', 'fail', 'blocked'];
const SEVERITIES = ['high', 'medium', 'low'];
const PASS_SCORE = 95;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

const string = { type: 'string', minLength: 1, maxLength: 2000 };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const UIDIFF_SCHEMA = object({
  screens: {
    type: 'array',
    items: object({
      slug: { type: 'string', pattern: SLUG.source },
      score: { type: 'integer', minimum: 0, maximum: 100 },
      verdict: { type: 'string', enum: VERDICTS },
      findings: { type: 'array', items: object({ text: string, severity: { type: 'string', enum: SEVERITIES } }) },
    }),
  },
});

function readFinding(value, where) {
  requireObject(value, ['text', 'severity'], where);
  return { text: textOf(value.text, `${where}: text`), severity: oneOf(value.severity, SEVERITIES, `${where}: severity`) };
}

function readScreen(value, slugs) {
  requireObject(value, ['slug', 'score', 'verdict', 'findings'], 'screen');
  const slug = oneOf(value.slug, slugs, 'slug');
  if (!Number.isInteger(value.score) || value.score < 0 || value.score > 100) fail(`${slug}: score phải là số nguyên 0-100`);
  const verdict = oneOf(value.verdict, VERDICTS, `${slug}: verdict`);
  const findings = requireList(value.findings, `${slug}: findings`).map(item => readFinding(item, `${slug}: findings`));
  const clean = value.score >= PASS_SCORE && !findings.some(f => f.severity === 'high');
  return { slug, score: value.score, verdict: verdict === 'pass' && !clean ? 'fail' : verdict, findings };
}

function documentOf(input) {
  if (typeof input !== 'string') return input;
  return lastJsonBlock(input) ?? parseJson(input);
}

function parseUidiff(input, { screens: expected } = {}) {
  if (!Array.isArray(expected) || expected.length === 0 || !expected.every(slug => typeof slug === 'string' && SLUG.test(slug))) throw new TypeError('screens phải là danh sách slug không rỗng');
  return attempt(() => {
    const doc = requireObject(documentOf(input), ['screens'], 'JSON');
    const found = new Map();
    for (const value of requireList(doc.screens, 'screens')) {
      const screen = readScreen(value, expected);
      if (found.has(screen.slug)) fail(`${screen.slug}: trùng màn`);
      found.set(screen.slug, screen);
    }
    return { screens: expected.map(slug => found.get(slug) ?? fail(`thiếu màn ${slug}`)) };
  });
}

module.exports = { parseUidiff, UIDIFF_SCHEMA, PASS_SCORE, SLUG };
