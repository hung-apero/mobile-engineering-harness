const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUidiff, UIDIFF_SCHEMA } = require('../src/specs/uidiff-result.cjs');

const SCREENS = ['home', 'result'];
const screen = (slug, extra = {}) => ({ slug, score: 97, verdict: 'pass', findings: [], ...extra });
const doc = (...screens) => ({ screens });
const parse = (input, screens = SCREENS) => parseUidiff(input, { screens });

test('a complete answer is accepted in the order of the expected screens', () => {
  const out = parse(doc(screen('result'), screen('home', { score: 80, verdict: 'fail', findings: [{ text: 'nút lệch 4px', severity: 'low' }] })));
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.screens.map(s => s.slug), SCREENS);
  assert.equal(out.screens[0].findings[0].text, 'nút lệch 4px');
});

test('the last json block of free text is read and the string form works', () => {
  const text = `xong\n\`\`\`json\n{"screens":[]}\n\`\`\`\nrồi\n\`\`\`json\n${JSON.stringify(doc(screen('home'), screen('result')))}\n\`\`\`\n`;
  assert.equal(parse(text).ok, true);
  assert.equal(parse(JSON.stringify(doc(screen('home'), screen('result')))).ok, true);
});

test('a missing, duplicate or unknown screen is rejected', () => {
  assert.match(parse(doc(screen('home'))).error, /thiếu màn result/);
  assert.match(parse(doc(screen('home'), screen('home'), screen('result'))).error, /trùng/);
  assert.equal(parse(doc(screen('home'), screen('result'), screen('other'))).ok, false);
});

test('extra fields anywhere are rejected', () => {
  assert.equal(parse({ screens: [screen('home'), screen('result')], extra: 1 }).ok, false);
  assert.equal(parse(doc(screen('home', { note: 'x' }), screen('result'))).ok, false);
  assert.equal(parse(doc(screen('home'), screen('result', { findings: [{ text: 'a', severity: 'low', file: 'x' }] }))).ok, false);
});

test('score must be an integer from 0 to 100', () => {
  for (const score of [-1, 101, 95.5, '97', null, NaN]) assert.equal(parse(doc(screen('home', { score }), screen('result'))).ok, false, String(score));
  for (const score of [0, 100]) assert.equal(parse(doc(screen('home', { score, verdict: 'fail' }), screen('result'))).ok, true, String(score));
});

test('verdict and severity must be from the closed lists', () => {
  assert.equal(parse(doc(screen('home', { verdict: 'ok' }), screen('result'))).ok, false);
  assert.equal(parse(doc(screen('home', { findings: [{ text: 'a', severity: 'blocker' }] }), screen('result'))).ok, false);
  assert.equal(parse(doc(screen('home', { findings: [{ text: '  ', severity: 'low' }] }), screen('result'))).ok, false);
});

test('a pass below 95 or with a high finding is turned into fail; blocked stays', () => {
  const low = parse(doc(screen('home', { score: 94 }), screen('result', { score: 40, verdict: 'blocked', findings: [{ text: 'app crash', severity: 'high' }] })));
  assert.equal(low.screens[0].verdict, 'fail');
  assert.equal(low.screens[1].verdict, 'blocked');
  const high = parse(doc(screen('home', { findings: [{ text: 'màu sai', severity: 'high' }] }), screen('result')));
  assert.equal(high.screens[0].verdict, 'fail');
  assert.equal(parse(doc(screen('home', { score: 95, findings: [{ text: 'nhỏ', severity: 'medium' }] }), screen('result'))).screens[0].verdict, 'pass');
});

test('secrets in finding text are redacted', () => {
  const out = parse(doc(screen('home', { verdict: 'fail', findings: [{ text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 lộ', severity: 'low' }] }), screen('result')));
  assert.ok(!out.screens[0].findings[0].text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('broken json, an unclosed block and a non-object are rejected without throwing', () => {
  assert.equal(parse('không phải json').ok, false);
  assert.equal(parse('```json\n{"screens":[]\n').ok, false);
  assert.equal(parse('[]').ok, false);
  assert.equal(parse(null).ok, false);
});

test('the expected screens must be a non-empty list of slugs', () => {
  for (const screens of [undefined, [], ['Bad Slug'], [1]]) assert.throws(() => parseUidiff(doc(), { screens }), TypeError);
});

test('the json schema lists the same fields the parser reads', () => {
  const item = UIDIFF_SCHEMA.properties.screens.items;
  assert.deepEqual(item.required, ['slug', 'score', 'verdict', 'findings']);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.properties.verdict.enum, ['pass', 'fail', 'blocked']);
});
