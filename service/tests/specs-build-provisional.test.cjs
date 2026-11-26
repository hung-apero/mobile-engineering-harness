const { test } = require('node:test');
const assert = require('node:assert/strict');
const files = require('../src/specs/repo-files.cjs');
const { setupBuild, REVIEW_OK } = require('./specs-build-fixtures.cjs');

const ASK = 'Nút đóng ở đâu?';
const itemOf = s => Object.values(s.spec().data.prov.items)[0];
const unanswered = s => s.facade.quiz(s.id).ask.filter(q => !q.answered).length;

async function asked(t, question = ASK) {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review({ ...REVIEW_OK, needsPo: [question] });
  return s;
}

test('a reviewer question goes to a new quiz round and the code goes on, the trial waits for the answer', async t => {
  const s = await asked(t);
  assert.equal(s.spec().state, 'candidate');
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual([quiz.round, quiz.spec.state, quiz.provisional, quiz.submitted], [2, 'quiz', true, false]);
  assert.deepEqual(quiz.ask.map(q => [q.id, q.title, q.proposal.label, q.blocking]), [['T1', ASK, 'A', true]]);
  assert.match(s.waits().find(w => w.role === 'po').link, /\/quiz\//);
  await s.gate();
  await s.build();
  await s.state('po-trial');
  const view = s.facade.review(s.id);
  assert.equal(view.trial.open, 1);
  assert.match(view.trial.notes[0], /Câu tạm chọn chưa xác nhận: Nút đóng ở đâu\? → Giữ như đang làm/);
  const refused = await s.approveTrial(view.sha);
  assert.deepEqual([refused.ok, /câu tạm chọn/.test(refused.error), s.spec().state], [false, true, 'po-trial']);
  assert.deepEqual(s.facade.submit(s.id, 'po', s.now), { ok: false, missing: ['T1'] });
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  assert.equal(s.facade.submit(s.id, 'po', s.now).ok, true);
  assert.throws(() => s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: 'x' }, 'po', s.now), { code: 'STATE' });
  await s.tick();
  assert.deepEqual([itemOf(s).status, s.spec().state], ['confirmed', 'po-trial']);
  assert.equal(s.decisions('spec-provisional-answered').length, 1);
  assert.equal((await s.approveTrial(view.sha)).ok, true);
});

test('a free answer sends the code back with the words of the PO and is not asked again', async t => {
  const s = await asked(t);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'Khác', text: 'Bỏ hẳn nút\n## đi' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.gate();
  await s.until(() => s.spec().state === 'building' && s.running('spec').length === 1, 'build lại');
  assert.match(files.read(s.repo(), 'inputs/rework-1.md'), /Nút đóng ở đâu\? → Khác — Bỏ hẳn nút ## đi/);
  await s.code({ files: { 'feature.txt': 'no button\n' } });
  await s.smoke();
  await s.review({ ...REVIEW_OK, needsPo: [ASK] });
  assert.equal(unanswered(s), 0);
  assert.equal(s.waits().filter(w => w.role === 'po').length, 0);
});

test('a hard to undo question holds the install until the PO confirms', async t => {
  const s = await asked(t, 'Thanh toán gói tuần qua đâu?');
  await s.gate();
  await s.build();
  await s.tick();
  assert.equal(s.spec().state, 'candidate');
  assert.equal(s.decisions('spec-trial-sent').length, 0);
  assert.equal(s.would().some(text => /firebase distribute/.test(text)), false);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.state('po-trial');
  assert.equal(s.decisions('spec-trial-sent').length, 1);
});

test('questions of a later review join the same round and drafts already given stay', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review({ ...REVIEW_OK, verdict: 'changes', needsPo: [ASK], findings: [{ file: 'feature.txt', line: 1, severity: 'major', text: 'thiếu màn trống' }] });
  assert.equal(s.spec().state, 'building');
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  await s.code({ files: { 'feature.txt': 'v2\n' } });
  await s.smoke();
  await s.review({ ...REVIEW_OK, needsPo: ['Màn trống hiện gì?'] });
  const quiz = s.facade.quiz(s.id);
  assert.equal(quiz.round, 2);
  assert.deepEqual(quiz.ask.map(q => [q.id, q.draft?.choice ?? null]), [['T1', 'A'], ['T2', null]]);
  assert.deepEqual(s.facade.submit(s.id, 'po', s.now).missing, ['T2']);
  assert.equal(s.spec().round, 2);
});

test('the PO can ask more about a reviewer question', async t => {
  const s = await asked(t);
  s.facade.ask(s.id, 'T1', 'Khác nhau thế nào?', 'po', s.now);
  await s.until(() => s.running('explain').length === 1, 'giải thích');
  const [job] = s.running('explain');
  assert.equal(job.payload.question.title, ASK);
  assert.throws(() => s.facade.ask(s.id, 'Q1', 'x', 'po', s.now), { code: 'INVALID' });
});
