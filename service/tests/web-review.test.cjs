const test = require('node:test');
const assert = require('node:assert/strict');
const { NOW, REVIEW, SHA, createFake, fail, reviewState, startWeb } = require('./web-fixtures.cjs');
const { hedged } = require('../src/web/approve-text.cjs');

const api = name => `/api/review/${REVIEW}/${name}`;
const withReview = state => createFake({ review: () => state });

test('the review shows the spec, changed parts, removed lines and both labels', async t => {
  const web = await startWeb(t);
  const { text } = await web.get(`/review/${REVIEW}`);
  assert.match(text, /<h2[^>]*>Phase 15<\/h2>/);
  assert.match(text, /<p class="changed"><ins>Câu mới/);
  assert.match(text, /<p>Giữ nguyên<\/p>/);
  assert.match(text, /<del>Câu cũ<\/del>/);
  assert.match(text, /PO chọn/);
  assert.match(text, /Agent tự chốt/);
  assert.match(text, /Figma 12:3/);
  assert.match(text, new RegExp(`data-sha="${SHA}"`));
});

test('an answer mark inside the spec carries its label', async t => {
  const web = await startWeb(t, { facade: withReview(reviewState({ markdown: 'a (Q1: B) b (Q3: A) c (Q8: A)', diff: [] })) });
  const { text } = await web.get(`/review/${REVIEW}`);
  assert.match(text, /\(Q1: B\) <span class="tag po">PO chọn<\/span>/);
  assert.match(text, /\(Q3: A\) <span class="tag agent">Agent tự chốt<\/span>/);
  assert.match(text, /\(Q8: A\) c|\(Q8: A\)/);
  assert.doesNotMatch(text, /\(Q8: A\) <span/);
});

test('approve is bound to the sha on screen', async t => {
  const web = await startWeb(t);
  const res = await web.post(api('approve'), { sha: SHA, quote: 'Tôi duyệt' });
  assert.equal(res.status, 200);
  assert.deepEqual(web.facade.of('approve')[0].args, [7, { sha: SHA, quote: 'Tôi duyệt' }, 'po', NOW]);
  const stale = await web.post(api('approve'), { sha: 'b'.repeat(64), quote: 'Tôi duyệt' });
  assert.equal(stale.status, 409);
  assert.equal(stale.json().code, 'STALE');
  for (const part of [{ sha: undefined }, { sha: 1 }, { quote: '' }, { quote: 5 }, { quote: 'x'.repeat(501) }]) {
    assert.equal((await web.post(api('approve'), { sha: SHA, quote: 'ok', ...part })).status, 400, JSON.stringify(part));
  }
  assert.equal(web.facade.of('approve').length, 1);
});

test('an approval with a condition is turned into a request for feedback', async t => {
  const web = await startWeb(t);
  for (const quote of ['ok nhưng đổi màu', 'OK, NHƯNG', 'duyệt trừ màn 3', 'duyệt hết ngoại trừ quảng cáo', 'ok nhung doi mau', 'ok nhưng'.normalize('NFD')]) {
    const res = await web.post(api('approve'), { sha: SHA, quote });
    assert.equal(res.status, 400, quote);
    assert.equal(res.json().code, 'HEDGED');
    assert.match(res.json().error, /góp ý/);
  }
  assert.equal(web.facade.of('approve').length, 0);
});

test('plain approvals are not mistaken for conditions', () => {
  for (const quote of ['Tôi duyệt bản này', 'ok, nhúng video như vậy là được', 'duyệt, phần này hơi trừu tượng']) assert.equal(hedged(quote), false, quote);
});

test('facade refusals of an approval are shown', async t => {
  let outcome = () => ({ ok: false, error: 'Bản này vừa đổi' });
  const web = await startWeb(t, { facade: createFake({ approve: () => outcome() }) });
  const res = await web.post(api('approve'), { sha: SHA, quote: 'ok' });
  assert.equal(res.status, 409);
  assert.match(res.json().error, /vừa đổi/);
  outcome = () => { throw fail('STALE'); };
  assert.equal((await web.post(api('approve'), { sha: SHA, quote: 'ok' })).status, 409);
});

test('feedback reaches the facade and empty feedback does not', async t => {
  const web = await startWeb(t);
  assert.equal((await web.post(api('feedback'), { text: ' ok nhưng đổi màu ', sha: SHA })).status, 200);
  assert.deepEqual(web.facade.of('feedback')[0].args, [7, { text: 'ok nhưng đổi màu' }, 'po', NOW]);
  for (const text of ['', '  ', null, 'x'.repeat(8001)]) assert.equal((await web.post(api('feedback'), { text, sha: SHA })).status, 400);
  assert.equal((await web.post(api('feedback'), { text: 'x', sha: 'c'.repeat(64) })).status, 409);
});

test('an approved spec and a spec being edited have no forms and refuse actions', async t => {
  const state = reviewState({ approved: true });
  const web = await startWeb(t, { facade: withReview(state) });
  assert.match((await web.get(`/review/${REVIEW}`)).text, /Đã duyệt/);
  Object.assign(state, { approved: false, spec: { ...state.spec, state: 'clarifying' } });
  for (const approved of [true, false]) {
    state.approved = approved;
    const { text } = await web.get(`/review/${REVIEW}`);
    assert.doesNotMatch(text, /id="approve"|id="feedback"/);
    assert.equal((await web.post(api('approve'), { sha: SHA, quote: 'ok' })).status, 409);
    assert.equal((await web.post(api('feedback'), { text: 'x', sha: SHA })).status, 409);
  }
  assert.equal(web.facade.calls.length, 0);
});

test('hostile spec text is escaped', async t => {
  const evil = '"><script>alert(1)</script>';
  const web = await startWeb(t, { facade: withReview(reviewState({
    markdown: `# ${evil}\n\n${evil}`, diff: [{ type: 'add', text: evil }, { type: 'del', text: evil }],
    poChoices: [{ id: evil, title: evil, label: evil, text: evil }], agentChoices: [{ id: 'Q1', title: evil, source: evil, reason: evil }],
    sha: evil,
  })) });
  assert.doesNotMatch((await web.get(`/review/${REVIEW}`)).text, /<script>|"><script/);
});
