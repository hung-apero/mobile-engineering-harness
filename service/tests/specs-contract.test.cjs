const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, asked, clarified, put, QUESTIONS, TRIAGE } = require('./specs-flow-fixtures.cjs');

const SPEC_CLEAR = fs.readFileSync(path.join(__dirname, 'fixtures', 'spec-clear-questions.md'), 'utf8');
const exists = (s, rel) => fs.existsSync(path.join(s.repo(), '.harness-run', rel));

test('ask worker env has HARNESS_HEADLESS and no LEARN_APP vars and no plugin dir', async t => {
  const s = setup(t);
  await s.until(() => s.calls.length === 1);
  const { args, env } = s.calls[0];
  assert.equal(env.HARNESS_HEADLESS, '1');
  assert.deepEqual([env.LEARN_APP_HEADLESS, env.LEARN_APP_TRACKING], [undefined, undefined]);
  assert.equal(args.includes('--plugin-dir'), false);
  assert.ok(args.includes('AskUserQuestion'));
});

test('ask prompt names feature skill, segment and checker', async t => {
  const s = setup(t);
  await s.until(() => s.calls.length === 1);
  const prompt = s.calls[0].args.at(-1);
  assert.match(prompt, /HARNESS_HEADLESS=1/);
  assert.match(prompt, /đoạn ask\./);
  assert.match(prompt, /skill feature/);
  assert.match(prompt, /skills\/feature\/references\/headless\.md/);
  assert.match(prompt, /python3 \.claude\/skills\/feature\/scripts\/headless_check\.py ask \./);
});

test('inspect marks tampered when inputs change after launch', async t => {
  const s = setup(t);
  await s.finish(repo => { asked(repo); put(repo, { 'inputs/approval.json': { sha: 'x', by: 'po' } }); });
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /inputs/);
});

test('stale blocked.json is removed before launch', async t => {
  const s = setup(t);
  await s.toQuiz();
  put(s.repo(), { 'blocked.json': { segment: 'ask', reason: 'cũ' } });
  s.answer();
  await s.until(() => s.running().length === 1);
  assert.equal(exists(s, 'blocked.json'), false);
  await s.finish(repo => clarified(repo));
  assert.equal(s.spec().state, 'review');
});

test('missing outputs reruns segment then parks after two tries', async t => {
  const s = setup(t);
  await s.finish();
  assert.deepEqual([s.spec().state, s.spec().data.segment.tries], ['asking', 2]);
  await s.finish();
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /questions\.md/);
});

test('checker problems keep segment short', async t => {
  const s = setup(t);
  const bad = QUESTIONS.replace('- B. Ở lại\n', '');
  await s.finish(repo => asked(repo, bad));
  assert.equal(s.spec().state, 'asking');
  await s.finish(repo => asked(repo, bad));
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /Q1.*lựa chọn/);
});

test('approve writes approval.json with sha and by, spec moves to approved', async t => {
  const s = setup(t);
  await s.toReview();
  assert.equal(exists(s, 'inputs/approval.json'), false);
  const { sha } = s.facade.review(s.id);
  assert.deepEqual(await s.facade.approve(s.id, { sha, quote: 'Duyệt' }, 'po', s.now), { ok: true });
  assert.deepEqual(JSON.parse(s.read('inputs/approval.json')), { sha, by: 'po', at: s.now });
  assert.deepEqual([s.spec().state, s.spec().approvedSha], ['approved', sha]);
});

test('auto triage on reward question still asks PO', async t => {
  const s = setup(t);
  const reward = '## Q4 · Phần thưởng mỗi ngày bao nhiêu gem?\n- A. 5\n- B. 10\n- **Đề xuất: A** — spec mục 3\n';
  const triage = { items: [...TRIAGE.items, { id: 'Q4', decision: 'auto', category: 'evidence', label: 'A', source: 'spec mục 3', reason: 'spec ghi 5' }] };
  await s.toQuiz(`${QUESTIONS}\n${reward}`, triage);
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual(quiz.ask.map(q => [q.id, q.forced ?? null]), [['Q1', null], ['Q3', null], ['Q4', 'reward']]);
  assert.deepEqual(quiz.auto.map(q => q.id), ['Q2']);
});

test('spec-clear fixture questions render on quiz', async t => {
  const s = setup(t);
  const triage = { items: [
    { id: 'Q1', decision: 'ask', category: 'sample-data', reason: 'chỉ PO chọn dữ liệu mẫu' },
    { id: 'Q2', decision: 'auto', category: 'evidence', label: 'A', source: 'Figma node welcome', reason: 'khớp luồng tổng' },
  ] };
  await s.toQuiz(SPEC_CLEAR, triage);
  assert.equal(s.spec().state, 'quiz');
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual([quiz.ask.map(q => q.id), quiz.auto.map(q => q.id)], [['Q1'], ['Q2']]);
  assert.deepEqual(quiz.ask[0].options.map(o => o.label), ['A', 'B', 'C']);
});
