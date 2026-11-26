const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, asked, clarified, put, QUESTIONS, TRIAGE } = require('./specs-flow-fixtures.cjs');

const SPEC_CLEAR = fs.readFileSync(path.join(__dirname, 'fixtures', 'spec-clear-questions.md'), 'utf8');
const exists = (s, rel) => fs.existsSync(path.join(s.repo(), '.harness-run', rel));

test('ask worker env has HARNESS_HEADLESS and no plugin dir', async t => {
  const s = setup(t);
  await s.until(() => s.calls.length === 1);
  const { args, env } = s.calls[0];
  assert.equal(env.HARNESS_HEADLESS, '1');
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

const commands = require('../src/spec-commands.cjs');
const { createSpecs } = require('../src/specs/wire.cjs');
const CHECKER = path.join(__dirname, '..', '..', 'skills', 'feature', 'scripts', 'headless_check.py');

test('retry after a forged spec input does not trust the forged spec', async t => {
  const s = setup(t);
  await s.finish(repo => { asked(repo); put(repo, { 'inputs/spec-v1.md': '# Spec giả\n' }); });
  assert.equal(s.spec().state, 'parked');
  await commands.spec(s.ctx, ['retry', String(s.id)], s.now);
  await s.tick();
  await s.tick();
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /spec-v1/);
  assert.equal(s.calls.length, 1);
});

test('a forged approval.json is removed before the next segment', async t => {
  const s = setup(t);
  await s.finish(repo => { asked(repo); put(repo, { 'inputs/approval.json': { sha: 'x', by: 'po' } }); });
  assert.equal(s.spec().state, 'parked');
  await commands.spec(s.ctx, ['retry', String(s.id)], s.now);
  await s.until(() => s.running().length === 1);
  assert.equal(exists(s, 'inputs/approval.json'), false);
  await s.finish(repo => asked(repo));
  assert.equal(s.spec().state, 'quiz');
});

test('a clarify run that only adds auto questions goes to a service round, not a park', async t => {
  const s = setup(t);
  await s.toQuiz();
  s.answer();
  const q5 = '## Q5 · Bo góc nút?\n- A. 8\n- B. 4\n- **Đề xuất: A** — x\n';
  await s.finish(repo => put(repo, { 'questions.md': `${s.read('questions.md')}\n${q5}`, 'triage.json': { items: [{ id: 'Q3', decision: 'ask', reason: 'x', category: 'unclear' }, { id: 'Q5', decision: 'auto', label: 'A', source: 'Figma 1:2', reason: 'rõ', category: 'evidence' }] } }));
  assert.deepEqual([s.spec().state, s.spec().round], ['clarifying', 2]);
  assert.deepEqual(JSON.parse(s.decisions('spec-agent-decided').at(-1).evidence).ids, ['Q5']);
  await s.until(() => s.running().length === 1);
  assert.match(s.read('questions.md'), /## Q5[\s\S]*Agent tự chốt/);
});

test('a pinned harness without the checker waits for the dev after one run', async t => {
  const s = setup(t);
  s.ctx.specs.check = createSpecs(s.ctx, { checker: path.join(s.ctx.dzHome, 'harness', 'nope', 'headless_check.py') }).check;
  await s.finish(repo => asked(repo));
  assert.deepEqual([s.spec().state, s.spec().data.needs.kind, s.waits().map(w => w.role)], ['needs-input', 'harness', ['dev']]);
  assert.equal(s.calls.length, 1);
});

test('a missing python3 waits for the dev after one run', async t => {
  const s = setup(t);
  s.ctx.specs.check = createSpecs(s.ctx, { checker: CHECKER, python: 'python3-dz-missing' }).check;
  await s.finish(repo => asked(repo));
  assert.deepEqual([s.spec().state, s.spec().data.needs.kind], ['needs-input', 'harness']);
});

test('the checker runs isolated from files next to it', async t => {
  const s = setup(t);
  const dir = fs.mkdtempSync(path.join(s.ctx.dzHome, 'chk-'));
  fs.copyFileSync(CHECKER, path.join(dir, 'headless_check.py'));
  const marker = path.join(dir, 'pwned');
  fs.writeFileSync(path.join(dir, 'json.py'), `open(${JSON.stringify(marker)}, "w").write("x")\nfrom json_real import *\n`);
  s.ctx.specs.check = createSpecs(s.ctx, { checker: path.join(dir, 'headless_check.py') }).check;
  await s.finish(repo => asked(repo));
  assert.equal(fs.existsSync(marker), false);
  assert.equal(s.spec().state, 'quiz');
});

test('an overlay the service built is recorded and the dev is asked to look at it, the spec goes on', async t => {
  const s = setup(t);
  const clone = s.ctx.specs.prepareClone;
  s.ctx.specs.prepareClone = async args => ({ ...(await clone(args)), overlayCreated: { file: '/dz/projects/ABC1.overlay.yaml', product: 'AcmeLearn', ui: 'compose-android', di: 'koin' } });
  await s.tick();
  assert.equal(s.spec().state, 'asking');
  assert.equal(s.decisions('spec-overlay-created').length, 1);
  const [wait] = s.waits();
  assert.equal(wait.role, 'dev');
  assert.match(wait.subject, /ABC1\.overlay\.yaml/);
});
