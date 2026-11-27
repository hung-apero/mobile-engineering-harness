const test = require('node:test');
const assert = require('node:assert/strict');
const { NOW, QUIZ, createFake, fail, question, quizState, startWeb } = require('./web-fixtures.cjs');
const { quizUrl, reviewUrl } = require('../src/web/links.cjs');

const api = name => `/api/quiz/${QUIZ}/${name}`;
const draft = { qid: 'Q1', choice: 'A', text: '', round: 1 };
const withQuiz = state => createFake({ quiz: () => state });
const card = (html, id) => html.split('<article').find(part => part.includes(`data-qid="${id}"`));

test('links are built from a base and a token', () => {
  assert.equal(quizUrl('http://127.0.0.1:8787/', 'abc'), 'http://127.0.0.1:8787/quiz/abc');
  assert.equal(reviewUrl('http://127.0.0.1:8787', 'abc'), 'http://127.0.0.1:8787/review/abc');
});

test('the quiz shows one card per question with reason, options, proposal and the other box', async t => {
  const web = await startWeb(t);
  const { text } = await web.get(`/quiz/${QUIZ}`);
  const one = card(text, 'Q1');
  assert.match(one, /Vì sao hỏi/);
  assert.match(one, /Cần trả lời/);
  assert.match(one, /class="option proposed"[\s\S]*value="B"[\s\S]*Đề xuất[\s\S]*đúng spec/);
  assert.match(one, /value="Khác"/);
  assert.match(one, /Hỏi thêm/);
  assert.match(one, /<legend/);
  assert.doesNotMatch(card(text, 'Q2'), /Cần trả lời/);
  assert.match(text, /<progress[^>]*max="2"[^>]*value="0"/);
  assert.match(text, /<button[^>]*id="submit"[^>]*disabled/);
});

test('the reason comes from the question, its forced group or its blocking mark', async t => {
  const ask = [question('Q1', { reason: 'Figma và spec khác nhau' }), question('Q2', { forced: 'money' }), question('Q3', { blocking: true }), question('Q4')];
  const web = await startWeb(t, { facade: withQuiz(quizState({ ask })) });
  const { text } = await web.get(`/quiz/${QUIZ}`);
  assert.match(card(text, 'Q1'), /Figma và spec khác nhau/);
  assert.match(card(text, 'Q2'), /tiền/);
  assert.match(card(text, 'Q3'), /quyết định phần sẽ làm/);
  assert.match(card(text, 'Q4'), /chưa đủ căn cứ/);
});

test('saved drafts come back selected, with their text and counted', async t => {
  const ask = [question('Q1', { blocking: true, draft: { choice: 'A', text: '' } }), question('Q2', { draft: { choice: 'Khác', text: 'ý <b>riêng</b>' } })];
  const web = await startWeb(t, { facade: withQuiz(quizState({ ask })) });
  const { text } = await web.get(`/quiz/${QUIZ}`);
  assert.match(card(text, 'Q1'), /value="A" checked/);
  assert.match(card(text, 'Q2'), /value="Khác" checked/);
  assert.match(card(text, 'Q2'), /ý &lt;b&gt;riêng&lt;\/b&gt;<\/textarea>/);
  assert.match(text, /<progress[^>]*value="2"/);
  assert.doesNotMatch(text, /id="submit"[^>]*disabled/);
});

test('hostile question text is escaped everywhere', async t => {
  const evil = '"><script>alert(1)</script>';
  const ask = [question('Q1', { title: evil, body: evil, reason: evil, options: [{ label: 'A', text: evil }], proposal: { label: 'A', reason: evil } })];
  const auto = [question('Q3', { title: evil, auto: { label: 'A', source: evil, reason: evil } })];
  const chats = [{ id: 1, qid: 'Q1', question: evil, answer: evil, state: 'done' }];
  const state = quizState({ ask, auto, chats, spec: { id: 7, project: evil, title: evil, state: 'quiz' } });
  const web = await startWeb(t, { facade: withQuiz(state) });
  for (const submitted of [false, true]) {
    state.submitted = submitted;
    assert.doesNotMatch((await web.get(`/quiz/${QUIZ}`)).text, /<script>|"><script/);
  }
});

test('agent-decided questions are listed with source and a way to change', async t => {
  const web = await startWeb(t);
  const { text } = await web.get(`/quiz/${QUIZ}`);
  const section = text.slice(text.indexOf('id="auto"'));
  for (const part of ['Agent tự chốt', 'Figma 12:3', 'Đổi câu này', 'data-auto="Q3"']) assert.ok(section.includes(part), part);
});

test('a second round shows only new questions, earlier ones stay read only', async t => {
  const ask = [question('Q1', { answered: true, answer: { kind: 'po', label: 'A', text: 'Một' } }), question('Q9')];
  const web = await startWeb(t, { facade: withQuiz(quizState({ ask, round: 2 })) });
  const { text } = await web.get(`/quiz/${QUIZ}`);
  assert.equal(card(text, 'Q1'), undefined);
  assert.ok(card(text, 'Q9'));
  assert.match(text, /<progress[^>]*max="1"/);
  assert.match(text, /Lần hỏi 2/);
  assert.match(text, /Đã trả lời trước đó[\s\S]*Câu hỏi Q1/);
  assert.equal((await web.post(api('draft'), { ...draft, round: 2 })).status, 400);
});

test('after submit the page is read only and says so', async t => {
  const web = await startWeb(t, { facade: withQuiz(quizState({ submitted: true, ask: [question('Q1', { draft: { choice: 'A', text: '' } })] })) });
  const { text } = await web.get(`/quiz/${QUIZ}`);
  assert.match(text, /Đã gửi câu trả lời/);
  assert.match(text, /PO chọn/);
  assert.doesNotMatch(text, /id="submit"|type="radio"|quiz\.js/);
});

test('a quiz that is not open yet says so instead of showing questions', async t => {
  const web = await startWeb(t, { facade: withQuiz(quizState({ spec: { id: 7, title: 'P', state: 'asking' }, ask: [], auto: [] })) });
  const { text } = await web.get(`/quiz/${QUIZ}`);
  assert.match(text, /đang chuẩn bị/);
  assert.doesNotMatch(text, /id="submit"/);
  assert.equal((await web.post(api('submit'), { round: 1 })).status, 409);
});

test('a draft reaches the facade with the fields and the time', async t => {
  const web = await startWeb(t);
  const text = 'dòng 1\n## Q9 · giả `x`';
  assert.equal((await web.post(api('draft'), { ...draft, choice: 'Khác', text })).status, 200);
  assert.deepEqual(web.facade.of('saveDraft')[0].args, [7, { qid: 'Q1', choice: 'Khác', text }, 'po', NOW]);
});

test('a draft with an unknown question, option or type is refused', async t => {
  const web = await startWeb(t);
  const wrong = [{ qid: 'Q99' }, { qid: 'Q3' }, { qid: '__proto__' }, { qid: 3 }, { choice: 'Z' }, { choice: null }, { choice: ['A'] }, { text: 5 }, { text: 'x'.repeat(2001) }];
  for (const part of wrong) assert.equal((await web.post(api('draft'), { ...draft, ...part })).status, 400, JSON.stringify(part));
  assert.equal(web.facade.calls.length, 0);
});

test('a tab left open from an earlier round cannot save or submit', async t => {
  const web = await startWeb(t, { facade: withQuiz(quizState({ round: 2 })) });
  for (const [name, data] of [['draft', draft], ['submit', { round: 1 }], ['auto', { ...draft, qid: 'Q3' }], ['submit', {}]]) {
    assert.equal((await web.post(api(name), data)).status, 409, name);
  }
  assert.equal(web.facade.calls.length, 0);
});

test('nothing can be saved or submitted again after submit', async t => {
  const web = await startWeb(t, { facade: withQuiz(quizState({ submitted: true })) });
  for (const [name, data] of [['draft', draft], ['submit', { round: 1 }], ['auto', { ...draft, qid: 'Q3' }], ['ask', { qid: 'Q1', text: 'sao?' }]]) {
    const res = await web.post(api(name), data);
    assert.equal(res.status, 409, name);
    assert.equal(res.json().code, 'STATE');
  }
  assert.equal(web.facade.calls.length, 0);
});

test('a draft that loses the race with a submit in another tab is reported', async t => {
  const web = await startWeb(t, { facade: createFake({ saveDraft: () => false, submit: () => { throw fail('STATE'); } }) });
  assert.equal((await web.post(api('draft'), draft)).status, 409);
  assert.equal((await web.post(api('submit'), { round: 1 })).status, 409);
});

test('submit passes the missing questions back', async t => {
  const result = { ok: false, missing: ['Q1'] };
  const web = await startWeb(t, { facade: createFake({ submit: () => result }) });
  const res = await web.post(api('submit'), { round: 1 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json().missing, ['Q1']);
  Object.assign(result, { ok: true, missing: [] });
  assert.equal((await web.post(api('submit'), { round: 1 })).json().ok, true);
});

test('asking more saves the question and never an answer', async t => {
  const web = await startWeb(t);
  assert.equal((await web.post(api('ask'), { qid: 'Q1', text: ' Khác nhau thế nào? ' })).status, 200);
  assert.deepEqual(web.facade.of('ask')[0].args, [7, 'Q1', 'Khác nhau thế nào?', 'po', NOW]);
  assert.equal(web.facade.of('saveDraft').length, 0);
  for (const text of ['', '   ', 'x'.repeat(1001), 4]) assert.equal((await web.post(api('ask'), { qid: 'Q1', text })).status, 400);
  assert.equal((await web.post(api('ask'), { qid: 'Q77', text: 'sao' })).status, 400);
});

test('only a few questions may wait for an answer at once', async t => {
  const chats = Array.from({ length: 5 }, (_, i) => ({ id: i, qid: 'Q1', question: 'x', answer: null, state: 'open' }));
  const web = await startWeb(t, { facade: withQuiz(quizState({ chats })) });
  assert.equal((await web.post(api('ask'), { qid: 'Q2', text: 'sao' })).status, 429);
});

test('state returns drafts and chats for polling, and stops after submit', async t => {
  const chats = [{ id: 1, qid: 'Q1', question: 'Sao?', answer: 'Vì **thế** <b>', state: 'done', by: 'po', specId: 7 }, { id: 2, qid: 'Q1', question: 'Nữa?', answer: null, state: 'open' }, { id: 3, qid: 'Q1', question: 'Lỗi?', answer: null, state: 'failed' }];
  const web = await startWeb(t, { facade: withQuiz(quizState({ chats, ask: [question('Q1', { draft: { choice: 'A', text: '' } })] })) });
  const body = (await web.get(api('state'))).json();
  assert.equal(body.round, 1);
  assert.equal(body.submitted, false);
  assert.deepEqual(body.drafts, { Q1: { choice: 'A', text: '' } });
  assert.deepEqual(body.chats.map(c => c.state), ['done', 'open', 'failed']);
  assert.deepEqual(Object.keys(body.chats[0]).sort(), ['answer', 'id', 'qid', 'question', 'state']);
});

test('changing an agent-decided question reaches the facade with a chosen option', async t => {
  const web = await startWeb(t);
  assert.equal((await web.post(api('auto'), { qid: 'Q3', choice: 'B', text: '', round: 1 })).status, 200);
  assert.deepEqual(web.facade.of('changeAuto')[0].args, [7, 'Q3', { choice: 'B', text: '' }, 'po', NOW]);
  for (const part of [{ qid: 'Q1' }, { choice: 'Z' }, { choice: 'Khác', text: ' ' }]) {
    assert.equal((await web.post(api('auto'), { qid: 'Q3', choice: 'B', text: '', round: 1, ...part })).status, 400);
  }
});

test('an option label may not break out of its attribute', async t => {
  const ask = [question('Q1', { options: [{ label: 'A" onclick="x', text: 't' }] })];
  const web = await startWeb(t, { facade: withQuiz(quizState({ ask })) });
  assert.doesNotMatch((await web.get(`/quiz/${QUIZ}`)).text, /" onclick="x/);
});

const rolesQuiz = () => quizState({
  provisional: true, auto: [],
  ask: [
    question('T1', { role: 'po', blocking: true, body: 'SDK chỉ trả correct/total' }),
    question('T2', { role: 'dev', blocking: true, sent: true, draft: { choice: 'A', text: '' } }),
    question('T3', { role: 'qa', blocking: true, answered: true, answer: { kind: 'po', label: 'A', text: '' } }),
  ],
  sections: [{ role: 'po', open: true, count: 1, sent: null }, { role: 'dev', open: false, count: 1, sent: { by: 'dev', at: NOW } }, { role: 'qa', open: false, count: 1, sent: null }],
});

test('the provisional quiz shows one part per role, only open parts can be answered and sent', async t => {
  const web = await startWeb(t, { facade: withQuiz(rolesQuiz()) });
  const { text } = await web.get(`/quiz/${QUIZ}`);
  for (const role of ['po', 'dev', 'qa']) assert.match(text, new RegExp(`<section id="${role}"`));
  assert.match(text, /<section id="po"[^>]*data-part="po"/);
  assert.doesNotMatch(text, /<section id="dev"[^>]*data-part/);
  assert.match(text, /id="submit-po"/);
  assert.doesNotMatch(text, /id="submit-dev"|id="submit-qa"/);
  assert.match(card(text, 'T1'), /SDK chỉ trả correct\/total/);
  assert.equal(card(text, 'T2'), undefined);
  assert.match(text, /Đã gửi, đang xử lý/);
  assert.match(text, /Đã chốt/);
});

test('sending a part passes its role to the service', async t => {
  const facade = withQuiz(rolesQuiz());
  const web = await startWeb(t, { facade });
  await web.post(api('submit'), { round: 1, role: 'dev' });
  await web.post(api('submit'), { round: 1, role: 'boss' });
  assert.deepEqual(facade.of('submit').map(call => [call.args[1], call.args[3]]), [['dev', 'dev'], ['po', undefined]]);
});
