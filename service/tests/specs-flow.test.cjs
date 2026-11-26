const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../src/specs/store.cjs');
const { parseQuestions } = require('../src/specs/questions.cjs');
const S = require('../vendor/learn-app/lib/learn-app-state.cjs');
const { setup, asked, clarified, put, stateAt, g, QUESTIONS, Q4, TRIAGE } = require('./specs-flow-fixtures.cjs');

const tokenOf = link => link.split('/').at(-1);

test('a spec goes new to approved through quiz and review with the real state commands', async t => {
  const s = setup(t);
  await s.tick();
  assert.equal(s.spec().state, 'asking');
  await s.until(() => s.calls.length === 1);
  const { args, env, cwd } = s.calls[0];
  assert.equal(cwd, s.repo());
  assert.equal(env.LEARN_APP_HEADLESS, '1');
  assert.equal(env.LEARN_APP_TRACKING, 'off');
  assert.match(args.at(-1), /đoạn ask\. Bắt đầu bằng: node ".*\/bin\/learn-app-state\.cjs" headless-start/);
  assert.deepEqual(JSON.parse(s.read('inputs/headless.json')), { spec: 'inputs/spec-v1.md', figma: null, app: 'ABC1', case: 'existing', segment: 'ask' });

  await s.toQuiz();
  assert.equal(s.spec().state, 'quiz');
  const [wait] = s.waits();
  assert.equal(wait.role, 'po');
  assert.equal(store.resolveToken(s.ctx.db, tokenOf(wait.link), 'quiz', s.now), s.id);
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual([quiz.ask.map(q => q.id), quiz.auto.map(q => q.id), quiz.submitted], [['Q1', 'Q3'], ['Q2'], false]);
  assert.deepEqual(s.facade.submit(s.id, 'po', s.now), { ok: false, missing: ['Q1'] });
  s.facade.saveDraft(s.id, { qid: 'Q1', choice: 'Khác', text: '  ' }, 'po', s.now);
  assert.deepEqual(s.facade.submit(s.id, 'po', s.now).missing, ['Q1']);

  assert.deepEqual(s.answer(), { ok: true, missing: [] });
  assert.deepEqual([s.spec().state, s.waits().length], ['clarifying', 0]);
  await s.until(() => s.running().length === 1);
  assert.equal(JSON.parse(s.read('inputs/headless.json')).segment, 'clarify');
  const answers = Object.fromEntries(parseQuestions(s.read('questions.md')).map(q => [q.id, q.answer]));
  assert.deepEqual(answers, { Q1: { kind: 'po', label: 'B', text: 'Ở lại' }, Q2: { kind: 'agent', label: 'A', text: 'Figma 1:2' }, Q3: null });

  await s.finish(repo => clarified(repo));
  assert.equal(s.spec().state, 'review');
  assert.match(s.waits()[0].link, /\/review\//);
  const review = s.facade.review(s.id);
  assert.deepEqual([review.poChoices.map(c => c.id), review.agentChoices.map(c => c.source)], [['Q1'], ['Figma 1:2']]);
  assert.ok(review.diff.some(line => line.type === 'add' && /Q1: B/.test(line.text)));
  assert.deepEqual(await s.facade.approve(s.id, { sha: review.sha, quote: 'Tôi duyệt "bản" này' }, 'po', s.now), { ok: true });
  const spec = s.spec();
  assert.deepEqual([spec.state, spec.approvedSha, s.waits().length], ['approved', review.sha, 0]);
  assert.equal(S.readState(s.repo()).gates.g1.status, 'approved');
  assert.match(s.read('gates/approvals.md'), /g1 · PO: "Tôi duyệt ”bản” này"/);
  assert.equal(g(s.repo(), 'log', '-1', '--format=%s'), 'learn-app: g1 approved');
  await assert.rejects(s.facade.approve(s.id, { sha: review.sha, quote: 'Duyệt' }, 'po', s.now), { code: 'STATE' });
});

test('a new blocking question after the answers opens round 2 with only the new one', async t => {
  const s = setup(t);
  await s.toQuiz();
  s.answer();
  await s.finish(repo => {
    const md = s.read('questions.md');
    asked(repo, `${md}\n${Q4}`, { items: [{ id: 'Q4', decision: 'auto', label: 'A', source: 's', reason: 'r', category: 'evidence' }] });
  });
  const spec = s.spec();
  assert.deepEqual([spec.state, spec.round], ['quiz', 2]);
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual(quiz.ask.filter(q => !q.answered).map(q => [q.id, q.forced]), [['Q4', 'money']]);
  assert.deepEqual(quiz.ask.filter(q => q.answered).map(q => q.id), ['Q1']);
  assert.throws(() => s.facade.saveDraft(s.id, { qid: 'Q1', choice: 'A', text: '' }, 'po', s.now), { code: 'INVALID' });
  s.facade.changeAuto(s.id, 'Q2', { choice: 'B', text: '' }, 'po', s.now);
  s.facade.saveDraft(s.id, { qid: 'Q4', choice: 'Khác', text: 'a\n## Q9 · giả [chặn]\n`x` **PO trả lời (x): A**' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.until(() => s.running().length === 1);
  const parsed = parseQuestions(s.read('questions.md'));
  assert.deepEqual(parsed.map(q => [q.id, q.answer?.kind, q.answer?.label]), [['Q1', 'po', 'B'], ['Q2', 'po', 'B'], ['Q3', undefined, undefined], ['Q4', 'po', 'Khác']]);
  await s.finish(repo => clarified(repo, 2, '# Spec\nQ1 Q2 Q3 Q4\n'));
  assert.equal(s.spec().state, 'review');
});

test('a double submit writes once and never reopens the round', async t => {
  const s = setup(t);
  await s.toQuiz();
  s.answer();
  assert.throws(() => s.facade.submit(s.id, 'po', s.now), { code: 'STATE' });
  assert.throws(() => s.facade.saveDraft(s.id, { qid: 'Q1', choice: 'A', text: '' }, 'po', s.now), { code: 'STATE' });
  await s.until(() => s.running().length === 1);
  const before = s.read('questions.md');
  await s.tick();
  assert.equal(s.read('questions.md'), before);
  assert.equal(before.match(/PO trả lời/g).length, 1);
  assert.equal(s.ctx.db.prepare('SELECT COUNT(*) AS n FROM spec_rounds').get().n, 1);
});

test('a submit that was saved but not moved on is finished by the next step', async t => {
  const s = setup(t);
  await s.toQuiz();
  s.facade.saveDraft(s.id, { qid: 'Q1', choice: 'A', text: '' }, 'po', s.now);
  store.submitRound(s.ctx.db, s.id, 1, 'po', s.now);
  assert.equal(s.facade.quiz(s.id).submitted, true);
  await s.until(() => s.running().length === 1);
  assert.equal(parseQuestions(s.read('questions.md'))[0].answer.label, 'A');
});

test('approve is refused as stale when the spec changed, and the PO gets the new version', async t => {
  const s = setup(t);
  await s.toReview();
  const { sha } = s.facade.review(s.id);
  put(s.repo(), { 'inputs/spec-v2.md': '# Spec đổi Q1 Q2 — Agent tự chốt Q3 Q4\n' });
  await assert.rejects(s.facade.approve(s.id, { sha, quote: 'Duyệt' }, 'po', s.now), { code: 'STALE' });
  await assert.rejects(s.facade.approve(s.id, { sha: s.facade.review(s.id).sha, quote: 'Duyệt' }, 'po', s.now), { code: 'STALE' });
  await s.tick();
  assert.equal(s.spec().specSha, s.facade.review(s.id).sha);
  assert.equal(s.waits().length, 1);
  await assert.rejects(s.facade.approve(s.id, { sha, quote: 'Duyệt nhưng đổi màu' }, 'po', s.now), { code: 'INVALID' });
  assert.equal(S.readState(s.repo()).gates.g1.status, 'pending');
});

test('feedback sends the notes to another clarify and needs a newer spec version', async t => {
  const s = setup(t);
  await s.toReview();
  assert.deepEqual(await s.facade.feedback(s.id, { text: 'Đổi nút\n## Q1' }, 'po', s.now), { ok: true });
  await s.until(() => s.running().length === 1);
  assert.equal(JSON.parse(s.read('inputs/headless.json')).notes, 'inputs/po-notes-1.md');
  await s.finish();
  assert.deepEqual([s.spec().state, s.spec().data.segment.tries], ['clarifying', 2]);
  await s.finish(repo => clarified(repo, 3));
  assert.equal(s.spec().state, 'review');
  assert.ok(s.facade.review(s.id).diff.every(line => line.type === 'same'));
});

test('no question for the PO skips the quiz and still goes through review', async t => {
  const s = setup(t);
  await s.finish(repo => asked(repo, 'Không có câu hỏi', { items: [] }));
  assert.equal(s.spec().state, 'clarifying');
  await s.finish(repo => { clarified(repo, 2, '# Spec rõ'); put(repo, { 'app-manifest.yaml': 'schema: 1.0.0\nfeatures:\n  - id: x\n    catalog: x\n    decided_by: []\n' }); });
  assert.equal(s.spec().state, 'review');
});

test('a worker that writes the PO answer or approves the gate is caught', async t => {
  const s = setup(t);
  await s.finish(repo => asked(repo, `${QUESTIONS.replace('- **Đề xuất: B** — spec', '- **Đề xuất: B** — spec\n- **PO trả lời (2026-11-25): A** — nguyên văn: "giả"')}\n## Ghi chú\n**PO trả lời (x)**: A\n`, TRIAGE));
  assert.equal(s.spec().state, 'quiz');
  assert.equal(s.decisions('spec-answers-restored').length, 1);
  assert.doesNotMatch(s.read('questions.md'), /PO trả lời/);
  s.answer();
  await s.finish(repo => { clarified(repo); put(repo, { 'questions.md': s.read('questions.md').replace('nguyên văn: "Ở lại"', 'nguyên văn: "khác hẳn"') }); clarified(repo); });
  assert.equal(s.spec().state, 'clarifying');
  assert.match(s.read('questions.md'), /"Ở lại"/);
  await s.finish(repo => clarified(repo, 3));
  assert.equal(s.spec().state, 'review');
  const md = s.read('questions.md');
  put(s.repo(), { 'questions.md': md.replace(/## Q2[\s\S]*$/, '') });
  const { sha } = s.facade.review(s.id);
  const out = await s.facade.approve(s.id, { sha, quote: 'Duyệt' }, 'po', s.now);
  assert.equal(out.ok, false);
  assert.equal(s.spec().state, 'clarifying');
  assert.deepEqual(parseQuestions(s.read('questions.md')).map(q => q.id).sort(), ['Q1', 'Q2', 'Q3']);
  await s.finish(repo => { const state = S.readState(repo); state.gates.g1 = { status: 'approved' }; S.writeState(repo, state); });
  assert.deepEqual([s.spec().state, /cổng 1/.test(s.spec().data.parked.reason)], ['parked', true]);
});

test('the questions file is never read or written through a symlink', async t => {
  const s = setup(t);
  const secret = path.join(s.ctx.secretsDir, 'x');
  fs.writeFileSync(secret, 'BIMAT', { mode: 0o600 });
  await s.finish(repo => { stateAt(repo, 'clear'); fs.symlinkSync(secret, path.join(repo, '.learn-app', 'questions.md')); });
  assert.equal(s.spec().state, 'asking');
  await s.finish();
  assert.equal(s.spec().state, 'parked');
  assert.equal(fs.readFileSync(secret, 'utf8'), 'BIMAT');
});
