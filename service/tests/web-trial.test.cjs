const { test } = require('node:test');
const assert = require('node:assert/strict');
const { REVIEW, SHA, createFake, reviewState, startWeb } = require('./web-fixtures.cjs');

const TRIAL = { version: '1.9.2', versionName: '1.9.2', versionCode: 12, pr: 'https://github.com/a/b/pull/1', live: true, notes: ['Nút <script>alert(1)</script> lệch'], open: 0 };
const pageOf = async (t, trial) => {
  const facade = createFake({ review: () => reviewState({ spec: { id: 7, project: 'AAP864', title: 'Phase 15', state: 'po-trial' }, markdown: '', diff: [], poChoices: [], agentChoices: [], trial: { ...TRIAL, ...trial } }) });
  const web = await startWeb(t, { facade });
  return { web, text: (await web.get(`/review/${REVIEW}`)).text };
};

test('the trial page names the commit, the version and the PR, and lists what is left first', async t => {
  const { text } = await pageOf(t);
  assert.match(text, new RegExp(`data-sha="${SHA}"`));
  assert.match(text, new RegExp(`<code>${SHA.slice(0, 12)}</code>`));
  assert.match(text, /1\.9\.2 \(12\)/);
  assert.match(text, /href="https:\/\/github\.com\/a\/b\/pull\/1"/);
  assert.ok(text.indexOf('lệch') < text.indexOf('class="facts"'));
  assert.doesNotMatch(text, /<script>alert/);
});

test('a dry run says that no install was sent and a bad link is not a link', async t => {
  const { text } = await pageOf(t, { live: false, pr: 'javascript:alert(1)', notes: [] });
  assert.match(text, /Chạy khô: chưa gửi bản cài thật/);
  assert.doesNotMatch(text, /javascript:/);
});

test('the PO cannot approve while provisional choices are open', async t => {
  const { text } = await pageOf(t, { open: 2 });
  assert.match(text, /Còn 2 câu tạm chọn/);
  assert.match(text, /<form id="approve" hidden>[^]*disabled/);
  assert.match((await pageOf(t)).text, /<form id="approve" class="panel stack">/);
});

test('approval and feedback of a trial go through the same checked calls', async t => {
  const { web } = await pageOf(t);
  assert.equal((await web.post(`/api/review/${REVIEW}/approve`, { sha: SHA, quote: 'Tôi duyệt' })).status, 200);
  assert.equal((await web.post(`/api/review/${REVIEW}/approve`, { sha: 'b'.repeat(64), quote: 'Tôi duyệt' })).status, 409);
  assert.equal((await web.post(`/api/review/${REVIEW}/feedback`, { sha: SHA, text: 'Sửa màu' })).status, 200);
  assert.deepEqual([web.facade.of('approve').length, web.facade.of('feedback').length], [1, 1]);
});

test('feedback that is kept but not applied yet tells the PO not to send it again', async t => {
  const facade = createFake({ review: () => reviewState({ spec: { id: 7, project: 'AAP864', title: 'x', state: 'po-trial' }, trial: TRIAL }), feedback: () => ({ ok: false, error: 'Đã ghi góp ý nhưng chưa đưa được vào việc code.' }) });
  const web = await startWeb(t, { facade });
  const res = await web.post(`/api/review/${REVIEW}/feedback`, { sha: SHA, text: 'Sửa màu' });
  assert.equal(res.status, 409);
  assert.match(res.text ?? JSON.stringify(res), /Đã ghi góp ý/);
});
