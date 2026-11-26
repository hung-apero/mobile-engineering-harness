const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReview, REVIEW_SCHEMA } = require('../src/bugs/result.cjs');

const A = 'fix/aap864-275-7';
const B = 'fix/aap864-276-7';
const lane = (branch, extra = {}) => ({ branch, verdict: 'approve', specMatch: true, needsPo: [], reversesIntentional: [], forbidden: [], findings: [], ...extra });
const finding = (extra = {}) => ({ file: 'app/A.kt', line: 3, severity: 'minor', text: 'tên biến', ...extra });
const options = { lanes: [{ branch: A, keys: ['AAP864-275'] }, { branch: B, keys: ['AAP864-276'] }] };
const parse = (value, extra = {}) => parseReview(value, { ...options, ...extra });
const one = extra => parse({ lanes: [lane(A, extra), lane(B)] });
const rejects = (value, pattern) => {
  const out = parse(value);
  assert.equal(out.ok, false);
  assert.match(out.error, pattern);
};

test('structured output is accepted as an object, as plain JSON text and as a json block', () => {
  const value = { lanes: [lane(A), lane(B, { verdict: 'changes', findings: [finding()] })] };
  for (const input of [value, JSON.stringify(value), `Kết luận:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``]) {
    const out = parse(input);
    assert.equal(out.ok, true);
    assert.deepEqual(out.lanes, value.lanes);
  }
});

test('every lane must be judged exactly once and no other', () => {
  rejects({ lanes: [lane(A)] }, new RegExp(B));
  rejects({ lanes: [lane(A), lane(A), lane(B)] }, /trùng/);
  rejects({ lanes: [lane(A), lane(B), lane('fix/khac-7')] }, /khac/);
});

test('unknown fields, missing fields and wrong types are rejected', () => {
  rejects({ lanes: [lane(A), lane(B)], note: 1 }, /note/);
  rejects({ lanes: [lane(A, { score: 1 }), lane(B)] }, /score/);
  for (const field of ['verdict', 'specMatch', 'needsPo', 'reversesIntentional', 'forbidden', 'findings']) rejects({ lanes: [lane(A, { [field]: undefined }), lane(B)] }, new RegExp(field));
  rejects({ lanes: [lane(A, { verdict: 'ok' }), lane(B)] }, /verdict/);
  rejects({ lanes: [lane(A, { specMatch: 'true' }), lane(B)] }, /specMatch/);
  rejects({ lanes: [lane(A, { forbidden: [1] }), lane(B)] }, /forbidden/);
  rejects({ lanes: [lane(A, { findings: [finding({ severity: 'high' })] }), lane(B)] }, /severity/);
  rejects({ lanes: [lane(A, { findings: [finding({ line: 1.5 })] }), lane(B)] }, /line/);
  rejects({ lanes: [lane(A, { findings: [finding({ extra: 1 })] }), lane(B)] }, /extra/);
  rejects({ lanes: [lane(A, { needsPo: [{ key: 'AAP864-9', question: 'q' }] }), lane(B)] }, /AAP864-9/);
  rejects({ lanes: [lane(A, { needsPo: [{ key: 'AAP864-275', question: '' }] }), lane(B)] }, /question/);
  rejects({ lanes: [lane(A, { reversesIntentional: [{ key: 'AAP864-275', commit: 'HEAD~1', why: 'x' }] }), lane(B)] }, /commit/);
  for (const value of [null, 3, 'xong', [], {}]) rejects(value, /./);
});

test('a key of another lane is a parse error, in questions and in reversed commits', () => {
  for (const extra of [{ needsPo: [{ key: 'AAP864-276', question: 'q' }] }, { reversesIntentional: [{ key: 'AAP864-276', commit: '2ead732b', why: 'x' }] }]) {
    rejects({ lanes: [lane(A, extra), lane(B)] }, /AAP864-276/);
  }
});

test('a short or full commit id may name the intentional commit', () => {
  for (const commit of ['2ead732b', 'a'.repeat(40)]) {
    const out = one({ reversesIntentional: [{ key: 'AAP864-275', commit, why: 'đảo mức sàn' }] });
    assert.equal(out.lanes[0].reversesIntentional[0].commit, commit);
  }
});

test('an approval that carries a blocker, a forbidden change or an unexplained spec mismatch becomes changes', () => {
  assert.equal(one({ findings: [finding({ severity: 'blocker' })] }).lanes[0].verdict, 'changes');
  assert.equal(one({ forbidden: ['sửa quyền'] }).lanes[0].verdict, 'changes');
  assert.equal(one({ specMatch: false }).lanes[0].verdict, 'changes');
  assert.equal(one({ specMatch: false, needsPo: [{ key: 'AAP864-275', question: 'mức nào?' }] }).lanes[0].verdict, 'approve');
  assert.equal(one({ findings: [finding({ severity: 'major' })] }).lanes[0].verdict, 'approve');
});

test('lanes come back in the expected order', () => {
  assert.deepEqual(parse({ lanes: [lane(B), lane(A)] }).lanes.map(l => l.branch), [A, B]);
});

test('texts are redacted and capped', () => {
  const out = one({ findings: [finding({ text: 'khoá Bearer abcdef' })] });
  assert.equal(out.lanes[0].findings[0].text, 'khoá [ẩn]');
  rejects({ lanes: [lane(A, { findings: [finding({ text: 'x'.repeat(2001) })] }), lane(B)] }, /text/);
});

test('calling without the expected lanes and their keys is a programming error', () => {
  assert.throws(() => parseReview({ lanes: [] }, {}), /lanes/);
  assert.throws(() => parseReview({ lanes: [] }, { lanes: [{ branch: A, keys: [] }] }), /keys/);
});

test('the schema describes every field the parser requires and forbids extras', () => {
  const item = REVIEW_SCHEMA.properties.lanes.items;
  assert.deepEqual([...item.required].sort(), Object.keys(lane(A)).sort());
  assert.equal(REVIEW_SCHEMA.additionalProperties, false);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(Object.keys(item.properties.findings.items.properties).sort(), Object.keys(finding()).sort());
});
