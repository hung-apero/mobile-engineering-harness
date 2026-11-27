const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseResult } = require('../src/bugs/result.cjs');

const SHA = 'a'.repeat(40);
const fixed = (key, extra = {}) => ({ key, verdict: 'confirmed', status: 'approved', branch: `fix/${key.toLowerCase()}-7`, commit: SHA, rootCause: 'sai hằng số', specRef: 'mục 3', ...extra });
const held = (key, extra = {}) => ({ key, verdict: 'conflict', status: 'skipped', question: 'hỏi PO', ...extra });
const block = value => `\`\`\`json\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\``;
const answer = (...tickets) => `Xong.\n${block({ tickets })}\n`;
const keys = ['AAP864-275', 'AAP864-276'];
const parse = (text, extra = {}) => parseResult(text, { allowedKeys: keys, ...extra });
const rejects = (text, pattern, extra) => {
  const out = parse(text, extra);
  assert.equal(out.ok, false, text);
  assert.match(out.error, pattern);
  assert.deepEqual(Object.keys(out), ['ok', 'error']);
};

test('a full answer is returned with every field and no missing key', () => {
  const out = parse(answer(fixed(keys[0]), held(keys[1])));
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, []);
  assert.deepEqual(out.tickets[0], { ...fixed(keys[0]), question: null, needs: null });
  assert.deepEqual(out.tickets[1], { key: keys[1], verdict: 'conflict', status: 'skipped', branch: null, commit: null, rootCause: null, specRef: null, question: 'hỏi PO', needs: null });
});

test('keys without a ticket are listed as missing', () => {
  assert.deepEqual(parse(answer(fixed(keys[0]))).missing, [keys[1]]);
  assert.deepEqual(parse(answer()).missing, keys);
});

test('only the last json block counts', () => {
  const out = parse(`${answer(fixed(keys[1]))}\nsửa lại:\n${answer(held(keys[0]))}`);
  assert.deepEqual(out.tickets.map(t => t.key), [keys[0]]);
  rejects(`${answer(fixed(keys[0]))}\n${block('{"tickets":')}`, /JSON/);
  rejects(`${answer(fixed(keys[0]))}\n\`\`\`json\n{"tickets":[]}`, /JSON/);
});

test('text that is not a string or has no json block is rejected', () => {
  for (const text of [null, undefined, '', 'xong', '```\n{"tickets":[]}\n```', JSON.stringify({ tickets: [] })]) rejects(text, /JSON/);
});

test('backticks inside a string value do not end the block', () => {
  assert.equal(parse(answer(fixed(keys[0], { rootCause: 'dùng ```x``` sai' }))).tickets[0].rootCause, 'dùng ```x``` sai');
});

test('the top level accepts nothing but a list of tickets', () => {
  for (const value of ['[]', 'null', '"x"', '{}', '{"tickets":{}}', '{"tickets":[],"extra":1}', '{"tickets":[],"__proto__":{}}']) rejects(block(value), /JSON|tickets/);
});

test('a ticket with an unknown field, or one that is not an object, is rejected', () => {
  rejects(answer(fixed(keys[0], { merge: true })), /merge/);
  for (const ticket of [null, 'x', [], 3]) rejects(answer(ticket), /ticket/);
});

test('a key outside the batch and a duplicate key are rejected', () => {
  rejects(answer(fixed('AAP864-9')), /AAP864-9/);
  rejects(answer(fixed(keys[0]), held(keys[0])), /trùng/);
  rejects(answer(fixed(keys[0], { key: undefined })), /key/);
  rejects(answer(fixed(keys[0], { key: 'toString' })), /key/);
});

test('verdict and status must come from the lists', () => {
  for (const verdict of ['confirmed', 'needs-confirm', 'spec-gap', 'conflict', 'needs-info', 'not-a-bug', 'duplicate', 'already-fixed', 'external', 'out-of-scope']) {
    assert.equal(parse(answer(held(keys[0], { verdict }))).ok, true, verdict);
  }
  for (const status of ['failed', 'blocked', 'skipped', 'needs-device']) assert.equal(parse(answer(held(keys[0], { status }))).ok, true, status);
  rejects(answer(held(keys[0], { verdict: 'fixed' })), /verdict/);
  rejects(answer(held(keys[0], { status: 'merged' })), /status/);
  rejects(answer(held(keys[0], { status: undefined })), /status/);
});

test('approved needs a confirmed verdict, a branch and a commit', () => {
  rejects(answer(fixed(keys[0], { verdict: 'conflict' })), /approved/);
  for (const field of ['branch', 'commit']) {
    for (const value of [undefined, null, '']) rejects(answer(fixed(keys[0], { [field]: value })), /approved/);
  }
});

test('a branch outside the fix pattern is rejected whatever the status', () => {
  for (const branch of ['main', 'fix/', 'fix/-a', 'fix/A-7', 'fix/a/b', 'fix/a_b', 'fix/a..b', 'refs/heads/fix/a', 'fix/a\n', `fix/${'a'.repeat(82)}`]) {
    rejects(answer(fixed(keys[0], { branch })), /branch/);
    rejects(answer(held(keys[0], { branch })), /branch/);
  }
});

test('a commit that is not 40 lowercase hex digits is rejected', () => {
  for (const commit of ['abc1234', 'A'.repeat(40), `${SHA}a`, `${SHA}\n`, 'g'.repeat(40), 7]) rejects(answer(fixed(keys[0], { commit })), /commit/);
});

test('an approved branch must end with the batch id when one is given', () => {
  assert.equal(parse(answer(fixed(keys[0])), { batchId: 7 }).ok, true);
  assert.equal(parse(answer(fixed(keys[0], { branch: 'fix/aap864-275-b7x' })), { batchId: 'B7X' }).ok, true);
  rejects(answer(fixed(keys[0])), /batch|đợt/, { batchId: '17' });
  rejects(answer(fixed(keys[0], { branch: 'fix/aap864-275-17' })), /batch|đợt/, { batchId: '7' });
  assert.equal(parse(answer(fixed(keys[0], { status: 'failed', branch: 'fix/khac' })), { batchId: '7' }).ok, true);
});

test('two tickets on one branch must name the same commit', () => {
  const branch = 'fix/aap864-275-7';
  assert.equal(parse(answer(fixed(keys[0]), fixed(keys[1], { branch }))).ok, true);
  rejects(answer(fixed(keys[0]), fixed(keys[1], { branch, commit: 'b'.repeat(40) })), /commit/);
});

test('free text must be a string of at most 2000 characters and is redacted', () => {
  for (const field of ['rootCause', 'specRef', 'question', 'needs']) {
    assert.equal(parse(answer(held(keys[0], { [field]: 'x'.repeat(2000) }))).ok, true);
    rejects(answer(held(keys[0], { [field]: 'x'.repeat(2001) })), new RegExp(field));
    rejects(answer(held(keys[0], { [field]: 5 })), new RegExp(field));
    assert.equal(parse(answer(held(keys[0], { [field]: 'Bearer abcdef' }))).tickets[0][field], '[ẩn]');
  }
});

test('an error never carries a secret or a long text', () => {
  const out = parse(answer(fixed(keys[0], { key: `ghp_${'a'.repeat(900)}` })));
  assert.equal(out.ok, false);
  assert.ok(!out.error.includes('ghp_'));
  assert.ok(out.error.length <= 300);
});

test('calling without the batch keys is a programming error', () => {
  for (const options of [undefined, {}, { allowedKeys: [] }, { allowedKeys: 'A-1' }]) assert.throws(() => parseResult(answer(), options), /allowedKeys/);
});
