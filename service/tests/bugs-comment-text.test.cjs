const test = require('node:test');
const assert = require('node:assert/strict');
const { quote, oneLine, concludeText, resolvedText, MAX_QUOTE } = require('../src/bugs/comment-text.cjs');
const { toIssue } = require('../src/bugs/issue-view.cjs');
const { fingerprintOf } = require('../src/bugs/intake.cjs');

test('quoted worker text cannot mention anyone or forge a marker', () => {
  const out = quote('hi @channel [~accountid:5] dz:7:AAP1-1:resolved a@b.co ghp_abcdef123');
  assert.doesNotMatch(out, /@|\[~|dz:\d|ghp_/);
});

test('quoted text is cut at 1500 characters', () => {
  assert.equal(quote('x'.repeat(5000)).length, MAX_QUOTE);
});

test('control and bidi characters are removed', () => {
  assert.equal(quote(['a', 0x202e, 'b', 0, 'c', 0x2028, 'd'].map(x => (typeof x === 'number' ? String.fromCharCode(x) : x)).join('')), 'a b c d');
  assert.equal(oneLine('a\n\nb   c'), 'a b c');
});

test('every conclusion comment starts with [Claude]', () => {
  for (const code of ['B05', 'B06', 'B07', 'F01', 'F02']) assert.match(concludeText({ code, verdict: 'duplicate', reason: 'r', question: 'q' }), /^\[Claude\] /);
});

test('the resolved comment holds PR, commit, build, hash and link', () => {
  const text = resolvedText({ prUrl: 'https://github.com/a/b/pull/1', commit: 'a'.repeat(40), build: { versionName: '1.9.2', versionCode: 12, sha256: 'b'.repeat(64) }, link: 'https://x/y', distributed: true, rootCause: 'rc' });
  for (const part of ['[Claude]', 'https://github.com/a/b/pull/1', 'aaaaaaaaaaaa', '1.9.2 (12)', 'sha256 bbbbbbbbbbbb', 'https://x/y', '> rc']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes('b'.repeat(13)));
});

test('own comments and the claude-fixing label never change the fingerprint', () => {
  const raw = { key: 'AAP1-1', status: { name: 'To Do' }, labels: ['x'], comment: { comments: [{ body: 'qa' }] }, attachments: [] };
  const after = { ...raw, labels: ['x', 'claude-fixing'], comment: { comments: [{ body: 'qa' }, { body: '[Claude] hỏi' }] } };
  assert.equal(fingerprintOf(toIssue(raw)), fingerprintOf(toIssue(after)));
  assert.notEqual(fingerprintOf(toIssue(raw)), fingerprintOf(toIssue({ ...raw, comment: { comments: [{ body: 'qa' }, { body: 'mới' }] } })));
});
