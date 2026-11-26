const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../vendor/learn-app/lib/learn-app-state.cjs');
const store = require('../../src/specs/store.cjs');
const { setupBuild, editState, put, PLAN } = require('./specs-build-fixtures.cjs');

const decision = (extra = {}) => ({ id: 'd1', question: 'Nút đóng ở đâu?', kind: 'business', options: [{ label: 'Trái', owner: 'x' }, { label: 'Phải', owner: 'x' }], choice: 'Trái', provisional: true, why: 'khớp spec nhất', ...extra });
const feature = (...decisions) => ({ id: 'path', source: 'app', status: 'done', files: [], gaps: [], decisions });
const choiceOf = s => S.readState(s.repo()).features[0].decisions[0];

async function asked(t, item = decision()) {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code({ features: [feature(item)] });
  return s;
}

test('a provisional choice made while coding goes to a new quiz round and the code goes on', async t => {
  const s = await asked(t);
  assert.equal(s.spec().state, 'smoking');
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual([quiz.round, quiz.spec.state, quiz.provisional, quiz.submitted], [2, 'quiz', true, false]);
  assert.deepEqual(quiz.ask.map(q => [q.id, q.title, q.proposal.label, q.blocking]), [['T1', 'Nút đóng ở đâu?', 'A', true]]);
  const wait = s.waits().find(w => w.role === 'po');
  assert.match(wait.link, /\/quiz\//);
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.state('po-trial');
  const view = s.facade.review(s.id);
  assert.equal(view.trial.open, 1);
  assert.match(view.trial.notes[0], /Câu tạm chọn chưa xác nhận: Nút đóng ở đâu\? → Trái/);
  const refused = await s.approveTrial(view.sha);
  assert.deepEqual([refused.ok, /câu tạm chọn/.test(refused.error), s.spec().state], [false, true, 'po-trial']);
  assert.deepEqual(s.facade.submit(s.id, 'po', s.now), { ok: false, missing: ['T1'] });
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  assert.equal(s.facade.submit(s.id, 'po', s.now).ok, true);
  assert.throws(() => s.facade.saveDraft(s.id, { qid: 'T1', choice: 'B', text: '' }, 'po', s.now), { code: 'STATE' });
  await s.tick();
  assert.deepEqual([choiceOf(s).choice, choiceOf(s).provisional], ['Trái', false]);
  assert.equal(s.spec().state, 'po-trial');
  assert.equal((await s.approveTrial(view.sha)).ok, true);
});

test('a changed provisional choice is written with decide and sends only its plan back to coding', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code({ features: [feature(decision())], plans: ['01-path', '02-quiz'] });
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'B', text: 'tay phải' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.until(() => s.running('spec').length === 1);
  await s.smoke();
  await s.until(() => s.spec().state === 'building');
  const state = S.readState(s.repo());
  assert.deepEqual([state.step, state.plans['01-path'].status, state.plans['02-quiz'].status], ['coding', 'todo', 'merged']);
  assert.deepEqual([choiceOf(s).choice, choiceOf(s).provisional], ['Phải', false]);
  assert.match(require('node:fs').readFileSync(`${s.repo()}/.learn-app/gates/approvals.md`, 'utf8'), /path\/d1: Phải · PO: "Phải — tay phải"/);
  assert.equal(s.devices.held.size, 0);
});

test('a free answer sends the plan back with the words of the PO and is not asked again', async t => {
  const s = await asked(t);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'Khác', text: 'Bỏ hẳn nút\n## đi' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.smoke();
  await s.until(() => s.spec().state === 'building');
  const back = S.readState(s.repo()).history.findLast(row => row.action === 'back');
  assert.match(back.reason, /Bỏ hẳn nút ## đi/);
  await s.code({ features: [feature(decision())] });
  assert.equal(s.facade.quiz(s.id).ask.filter(q => !q.answered).length, 0);
  assert.equal(s.waits().filter(w => w.role === 'po').length, 0);
});

test('a hard to undo decision stops that part until the PO answers', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const open = decision({ question: 'Xoá dữ liệu người dùng cũ?', choice: undefined, provisional: undefined, blocking: true });
  await s.finish(repo => {
    put(repo, { 'plans/01-path.md': PLAN('01-path'), 'headless-blocked.json': { step: 'coding', reason: 'chờ PO chọn', missing: [] } });
    editState(repo, state => {
      state.step = 'coding';
      state.features = [feature(open)];
      state.plans = { '01-path': { status: 'waiting-po', files: [], resumeTo: 'todo' } };
    });
  });
  assert.equal(s.spec().state, 'provisional');
  assert.match(s.waits()[0].link, /\/quiz\//);
  await s.tick();
  assert.equal(s.running('spec').length, 0);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'B', text: '' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.until(() => s.running('spec').length === 1);
  assert.equal(s.spec().state, 'building');
  assert.deepEqual([choiceOf(s).choice, S.readState(s.repo()).plans['01-path'].status], ['Phải', 'todo']);
});

test('a hard choice the worker took by itself holds the install until the PO confirms', async t => {
  const s = await asked(t, decision({ question: 'Thanh toán gói tuần qua đâu?' }));
  await s.smoke();
  await s.tick();
  assert.equal(s.spec().state, 'reviewing');
  assert.equal(s.running('spec').length, 0);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.review();
  assert.equal(s.spec().state, 'candidate');
});

test('questions of the reviewer join the same round and drafts already given stay', async t => {
  const s = await asked(t);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  await s.smoke();
  await s.review({ verdict: 'approve', specMatch: true, needsPo: ['Màn trống hiện gì?'], forbidden: [], findings: [] });
  const quiz = s.facade.quiz(s.id);
  assert.equal(quiz.round, 2);
  assert.deepEqual(quiz.ask.map(q => [q.id, q.draft?.choice ?? null]), [['T1', 'A'], ['T2', null]]);
  assert.deepEqual(s.facade.submit(s.id, 'po', s.now).missing, ['T2']);
  const spec = store.getSpec(s.ctx.db, s.id);
  assert.equal(spec.round, 2);
});

test('the PO can ask more about a provisional question', async t => {
  const s = await asked(t);
  s.facade.ask(s.id, 'T1', 'Khác nhau thế nào?', 'po', s.now);
  await s.until(() => s.running('explain').length === 1);
  const [job] = s.running('explain');
  assert.equal(job.payload.question.title, 'Nút đóng ở đâu?');
  assert.throws(() => s.facade.ask(s.id, 'Q1', 'x', 'po', s.now), { code: 'INVALID' });
});
