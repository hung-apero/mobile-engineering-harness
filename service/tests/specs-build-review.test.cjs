const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFeatureReview } = require('../src/specs/feature-review.cjs');
const { setupBuild, REVIEW_OK } = require('./specs-build-fixtures.cjs');

const changes = text => ({ ...REVIEW_OK, verdict: 'changes', findings: [{ file: 'feature.txt', line: 1, severity: 'major', text }] });
const recode = async (s, n) => {
  await s.code({ files: { 'feature.txt': `feature ${n}\n` } });
  await s.smoke();
};

async function toReview(t, files) {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code({ files });
  await s.smoke();
  return s;
}

test('code that touches a forbidden path or leaks a secret is parked before any review (F02)', async t => {
  for (const files of [{ 'billing/pay.kt': 'x\n' }, { 'config.txt': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' }]) {
    const s = await toReview(t, files);
    await s.state('parked');
    assert.match(s.spec().data.parked.reason, /F02/);
    assert.equal(s.decisions('spec-diff-refused').length, 1);
    assert.deepEqual([s.running('spec').length, s.would()], [0, []]);
  }
});

test('a review that asks for changes goes back to the build, twice at most (F01)', async t => {
  const s = await toReview(t);
  await s.review(changes('thiếu màn kết quả'));
  assert.equal(s.spec().state, 'building');
  assert.equal(s.spec().data.build.fixes, 1);
  await recode(s, 2);
  await s.review(changes('vẫn thiếu'));
  assert.equal(s.spec().state, 'building');
  await recode(s, 3);
  await s.review(changes('vẫn thiếu nữa'));
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /sửa 2 vòng vẫn chưa đạt/);
  assert.deepEqual(s.would(), []);
});

test('a red gate or build of the candidate goes back to the code and no install is sent', async t => {
  for (const red of ['gate', 'build']) {
    const s = await toReview(t);
    await s.review();
    if (red === 'build') await s.gate();
    await s[red](false);
    await s.state('building');
    assert.deepEqual(s.would(), []);
    await recode(s, 2);
    await s.review();
    await s.gate();
    await s.build();
    await s.state('po-trial');
    assert.equal(s.spec().data.build.candidate.n, 2);
  }
});

test('a question of the reviewer goes to the PO quiz', async t => {
  const s = await toReview(t);
  await s.review({ ...REVIEW_OK, needsPo: ['Nút quay lại về màn nào?'] });
  await s.gate();
  await s.build();
  await s.tick();
  assert.match(JSON.stringify(s.facade.quiz(s.id)), /Nút quay lại về màn nào/);
});

test('an unreadable review runs again once, then parks', async t => {
  const s = await toReview(t);
  await s.review({});
  assert.equal(s.spec().state, 'reviewing');
  await s.review({ verdict: 'approve' });
  assert.equal(s.spec().state, 'parked');
});

test('a review result is only an approval when nothing in it blocks', () => {
  const verdict = extra => parseFeatureReview({ ...REVIEW_OK, ...extra }).verdict;
  assert.equal(verdict({}), 'approve');
  assert.equal(verdict({ forbidden: ['quyền mới'] }), 'changes');
  assert.equal(verdict({ findings: [{ file: 'a', line: 1, severity: 'blocker', text: 'x' }] }), 'changes');
  assert.equal(verdict({ specMatch: false }), 'changes');
  assert.equal(parseFeatureReview({ ...REVIEW_OK, extra: 1 }).ok, false);
});

test('the review worker only reads', async t => {
  const s = await toReview(t);
  await s.until(() => s.running('spec').length === 1, 'review');
  const { args, cwd } = s.calls.at(-1);
  assert.match(cwd, new RegExp(`batches/spec-${s.id}/review`));
  assert.ok(!fs.existsSync(path.join(cwd, 'local.properties')));
  const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
  assert.doesNotMatch(allowed, /Edit|Write/);
  assert.match(args.at(-1), /Chỉ đọc/);
});

test('needsPo takes structured questions with a role and still reads plain strings', () => {
  const base = { verdict: 'approve', specMatch: true, forbidden: [], findings: [] };
  const ask = { role: 'qa', question: 'Test trên máy nào?', context: '', now: 'Pixel 6', options: ['Máy Android 10'], recommend: 'C', why: '', same: 'T2,T5' };
  const parsed = parseFeatureReview({ ...base, needsPo: [ask, 'Nút ở đâu?'] });
  assert.deepEqual(parsed.needsPo.map(q => [q.role, q.question, q.recommend, q.same]), [['qa', 'Test trên máy nào?', 'A', 'T2,T5'], ['po', 'Nút ở đâu?', 'A', '']]);
  assert.equal(parseFeatureReview({ ...base, needsPo: [{ ...ask, role: 'pm' }] }).ok, false);
});
