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

async function toTrial(s) {
  await s.gate();
  await s.build();
  await s.state('po-trial');
}

test('a reviewer question is chosen provisionally, the code goes on and the PO is asked with the install', async t => {
  const s = await asked(t);
  assert.equal(s.spec().state, 'candidate');
  assert.equal(itemOf(s).picked, 'A');
  assert.equal(s.waits().filter(w => w.role === 'po').length, 0);
  assert.equal(s.spec().round, 1);
  await toTrial(s);
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual([quiz.round, quiz.provisional, quiz.submitted], [2, true, false]);
  assert.deepEqual(quiz.ask.map(q => [q.id, q.title, q.proposal.label, q.blocking]), [['T1', ASK, 'A', true]]);
  assert.match(s.waits().find(w => w.role === 'po').link, /\/quiz\//);
  const view = s.facade.review(s.id);
  assert.equal(view.trial.open, 1);
  assert.match(view.trial.notes[0], /Câu tạm chọn chưa xác nhận: Nút đóng ở đâu\? → Giữ như code đang làm: Nút ở góc trên/);
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
  await toTrial(s);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'Khác', text: 'Bỏ hẳn nút\n## đi' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
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

test('questions of every review wait and are asked together with the install', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review({ ...REVIEW_OK, verdict: 'changes', needsPo: [ASK], findings: [{ file: 'feature.txt', line: 1, severity: 'major', text: 'thiếu màn trống' }] });
  assert.equal(s.spec().state, 'building');
  await s.code({ files: { 'feature.txt': 'v2\n' } });
  await s.smoke();
  assert.match(s.waits().find(w => w.role === 'po').link, /\/quiz\/.+#po$/);
  await s.review({ ...REVIEW_OK, needsPo: ['Màn trống hiện gì?'] });
  assert.equal(s.waits().filter(w => w.role === 'po').length, 1);
  await toTrial(s);
  const quiz = s.facade.quiz(s.id);
  assert.equal(quiz.round, 2);
  assert.deepEqual(quiz.ask.map(q => q.id), ['T1', 'T2']);
  assert.deepEqual(s.facade.submit(s.id, 'po', s.now).missing, ['T1', 'T2']);
  assert.equal(s.spec().round, 2);
});

test('the PO can ask more about a reviewer question', async t => {
  const s = await asked(t);
  await toTrial(s);
  s.facade.ask(s.id, 'T1', 'Khác nhau thế nào?', 'po', s.now);
  await s.until(() => s.running('explain').length === 1, 'giải thích');
  const [job] = s.running('explain');
  assert.equal(job.payload.question.title, ASK);
  assert.throws(() => s.facade.ask(s.id, 'Q1', 'x', 'po', s.now), { code: 'INVALID' });
});

const DEV_ASK = { role: 'dev', question: 'Bật mẫu cứng cả bản release?', context: 'useLocalSampleSource = true', now: 'Bật cho mọi bản', options: ['Chỉ bản debug'], recommend: 'B', why: 'Tránh dữ liệu mẫu lên store', same: '' };
const PO_ASK = { role: 'po', question: 'Accuracy dùng tỉ lệ câu đạt?', context: 'SDK chỉ trả correct/total', now: 'Tỉ lệ câu đạt', options: ['Chờ SDK có điểm'], recommend: 'A', why: 'Làm được ngay', same: '' };

async function askedByRole(t) {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review({ ...REVIEW_OK, verdict: 'changes', needsPo: [DEV_ASK, PO_ASK], findings: [{ file: 'feature.txt', line: 1, severity: 'major', text: 'thiếu màn trống' }] });
  await s.code({ files: { 'feature.txt': 'v2\n' } });
  return s;
}

test('questions are split by role, sent once the build is done, each part with its own link', async t => {
  const s = await askedByRole(t);
  const waits = s.waits().filter(w => /câu phần/.test(w.subject));
  assert.deepEqual(waits.map(w => [w.role, w.link.split('#')[1]]).sort(), [['dev', 'dev'], ['po', 'po']]);
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual(quiz.sections.map(part => [part.role, part.open, part.count]), [['po', true, 1], ['dev', true, 1]]);
  const dev = quiz.ask.find(q => q.role === 'dev');
  assert.deepEqual([dev.body, dev.options.map(o => o.text), dev.proposal.label], ['useLocalSampleSource = true', ['Giữ như code đang làm: Bật cho mọi bản', 'Chỉ bản debug'], 'B']);
});

test('each role sends its own part and only that part is settled', async t => {
  const s = await askedByRole(t);
  const dev = s.facade.quiz(s.id).ask.find(q => q.role === 'dev');
  const po = s.facade.quiz(s.id).ask.find(q => q.role === 'po');
  assert.deepEqual(s.facade.submit(s.id, 'dev', s.now, 'dev'), { ok: false, missing: [dev.id] });
  s.facade.saveDraft(s.id, { qid: dev.id, choice: 'A', text: '' }, 'dev', s.now);
  assert.equal(s.facade.submit(s.id, 'dev', s.now, 'dev').ok, true);
  assert.throws(() => s.facade.saveDraft(s.id, { qid: dev.id, choice: 'B', text: '' }, 'dev', s.now), { code: 'INVALID' });
  await s.tick();
  const items = Object.values(s.spec().data.prov.items);
  assert.deepEqual(items.map(item => [item.role, item.status]).sort(), [['dev', 'confirmed'], ['po', 'open']]);
  assert.deepEqual(s.waits().filter(w => /câu phần/.test(w.subject)).map(w => w.role), ['po']);
  assert.equal(s.facade.quiz(s.id).sections.find(part => part.role === 'po').open, true);
  assert.equal(po.role, 'po');
});

test('a reviewer question marked same as an open one updates it instead of asking again', async t => {
  const s = await askedByRole(t);
  await s.smoke();
  await s.review({ ...REVIEW_OK, needsPo: [{ ...DEV_ASK, question: 'Mẫu cứng có lên store không?', same: 'T1' }] });
  const items = Object.values(s.spec().data.prov.items);
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.qid === 'T1').title, 'Mẫu cứng có lên store không?');
});

test('dz spec ask sends the open questions at once with a new reminder per role', async t => {
  const s = await askedByRole(t);
  const before = s.waits().filter(w => /câu phần/.test(w.subject)).map(w => w.link);
  s.now += 60000;
  const [line] = await s.cmd('ask', String(s.id));
  assert.match(line, /Đã gửi 2 câu chờ chốt của spec #\d+: PO 1 · Dev 1/);
  const after = s.waits().filter(w => /câu phần/.test(w.subject));
  assert.deepEqual(after.map(w => w.role).sort(), ['dev', 'po']);
  assert.equal(after.some(w => before.includes(w.link)), false);
  assert.deepEqual(s.facade.overview(s.now).specs.find(spec => spec.id === s.id).asks, { po: 1, dev: 1, qa: 0 });
});

test('dz spec ask refuses a spec with nothing to ask', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await assert.rejects(async () => s.cmd('ask', String(s.id)), /không còn câu nào chờ chốt/);
});

test('a reviewer question naming several open ones rewrites the first and merges the rest', async t => {
  const s = await askedByRole(t);
  await s.smoke();
  await s.review({ ...REVIEW_OK, needsPo: [{ ...PO_ASK, question: 'Accuracy Speaking tính thế nào?', options: ['Chờ SDK', 'Ẩn ô Accuracy'], same: 'T2,T1' }] });
  const items = Object.fromEntries(Object.values(s.spec().data.prov.items).map(item => [item.qid, item]));
  assert.deepEqual([items.T2.status, items.T2.title, items.T2.options.length], ['open', 'Accuracy Speaking tính thế nào?', 3]);
  assert.deepEqual([items.T1.status, items.T1.into], ['merged', 'T2']);
  assert.deepEqual(s.facade.quiz(s.id).ask.map(q => q.id), ['T2']);
});

test('a question that does not say what the code does waits for the reviewer and is never shown bare', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const legacy = { key: 'review/old', qid: 'T1', role: 'po', title: 'Popup hiện mấy lần?', options: [{ label: 'A', text: 'Giữ như đang làm', value: 'A' }], value: 'A', picked: 'A', status: 'open', apply: false, hard: false };
  const data = { ...s.spec().data, prov: { items: { [legacy.key]: legacy }, next: 2, round: null, settled: null } };
  s.ctx.db.prepare('UPDATE specs SET data = ? WHERE id = ?').run(JSON.stringify(data), s.id);
  await s.code();
  await s.smoke();
  assert.equal(s.waits().filter(w => /câu phần/.test(w.subject)).length, 0);
  assert.ok(!(s.facade.quiz(s.id).ask ?? []).some(q => q.id === 'T1'));
  await s.until(() => s.running('spec').length === 1, 'review');
  const [job] = s.running('spec');
  assert.deepEqual(job.payload.asked, [{ qid: 'T1', role: 'po', title: 'Popup hiện mấy lần?', missingNow: true }]);
  await s.review({ ...REVIEW_OK, needsPo: [{ role: 'po', question: 'Popup giới thiệu hiện mấy lần?', context: 'Chưa có lộ trình', now: 'Hiện lại mỗi lần vào tab Learning', options: ['Chỉ hiện một lần'], recommend: 'B', why: 'Đỡ phiền', same: 'T1' }] });
  await toTrial(s);
  const quiz = s.facade.quiz(s.id);
  assert.deepEqual(quiz.ask.map(q => [q.id, q.options.map(o => o.text)]), [['T1', ['Giữ như code đang làm: Hiện lại mỗi lần vào tab Learning', 'Chỉ hiện một lần']]]);
});
