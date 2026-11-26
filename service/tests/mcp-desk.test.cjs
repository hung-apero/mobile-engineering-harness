const { test } = require('node:test');
const assert = require('node:assert/strict');
const inbox = require('../src/inbox.cjs');
const { NOW, MIN, TOKEN, CHANNEL, THREAD, ELSEWHERE, PO, OTHER, idAt, project, review, quiz, setup } = require('./mcp-fixtures.cjs');
const { say } = require('./mcp-approve-fixtures.cjs');

const SPEC_URL = 'https://example.atlassian.net/wiki/spaces/EX/pages/332470208/Phase';
const FIGMA_URL = 'https://www.figma.com/design/AbC123/x';
const code = async promise => {
  const result = await promise;
  return result.ok ? 'ok' : result.error.code;
};

test('submit reads the links from the message of the PO', async t => {
  const s = setup(t);
  const { ok, result } = await s.call('submit', s.discord.post(`Spec mới <${SPEC_URL}> ${FIGMA_URL}.`));
  assert.equal(ok, true);
  assert.equal(result.specId, 41);
  assert.deepEqual(s.facade.of('newSpec')[0].args, [{ project: 'AAP864', source: { type: 'url', ref: SPEC_URL }, figma: FIGMA_URL, title: null }, NOW]);
});

test('submit refuses people without the role, missing or several links and unusable links', async t => {
  const s = setup(t);
  assert.equal(await code(s.call('submit', s.discord.post(SPEC_URL, { author: { id: OTHER } }))), 'REFUSED');
  const bad = ['làm app này đi', FIGMA_URL, `${SPEC_URL} https://example.com/pages/12`, 'https://example.com/khong-co-ma', 'file:///etc/passwd', `${SPEC_URL} ${FIGMA_URL} ${FIGMA_URL}2`];
  for (const text of bad) assert.equal(await code(s.call('submit', s.discord.post(text))), 'INVALID', text);
  assert.deepEqual(s.facade.names(), []);
});

test('submit after fixing the same message works and is then used once', async t => {
  const s = setup(t);
  const id = s.discord.post('spec đây');
  assert.equal(await code(s.call('submit', id)), 'INVALID');
  Object.assign(s.discord.messages.get(id), { content: SPEC_URL, edited_timestamp: '2026-11-25T03:00:00Z' });
  assert.equal(await code(s.call('submit', id)), 'ok');
  assert.equal(await code(s.call('submit', id)), 'USED');
  assert.equal(s.facade.of('newSpec').length, 1);
});

test('submit in a channel of two apps needs the key in the text, a key inside a link is not enough', async t => {
  const s = setup(t, { projects: [project('AAP864'), project('AIP310')] });
  assert.equal(await code(s.call('submit', s.discord.post(SPEC_URL))), 'CHOOSE');
  assert.equal(await code(s.call('submit', s.discord.post(`${SPEC_URL}/AIP310`))), 'CHOOSE');
  const { result } = await s.call('submit', s.discord.post(`[AIP310] ${SPEC_URL}`));
  assert.equal(result.project, 'AIP310');
});

test('answer saves drafts, and submits only when the message says so', async t => {
  const s = setup(t, { specs: [quiz(3)] });
  const { result } = await s.call('answer', s.discord.post('Q1: a\nQ2: Khác: giữ như cũ'));
  assert.equal(result.submitted, false);
  assert.deepEqual(s.facade.of('saveDraft').map(c => c.args), [
    [3, { qid: 'Q1', choice: 'A', text: '' }, `discord:${PO}`, NOW],
    [3, { qid: 'Q2', choice: 'Khác', text: 'giữ như cũ' }, `discord:${PO}`, NOW],
  ]);
  assert.deepEqual(s.facade.of('submit'), []);
  assert.equal((await s.call('answer', s.discord.post('nộp'))).result.submitted, true);
});

test('answer is all or nothing when a line is wrong, and the message stays usable', async t => {
  const s = setup(t, { specs: [quiz(3)] });
  const bad = ['Q1: A\nQ9: B', 'Q1: A\nQ3: B', 'Q1: A\nQ1: B', 'Q1: A nhưng bỏ nút', 'Q1: A hay B?', 'Q1: A\nlinh tinh', 'Q1: Z', 'chọn giúp tôi'];
  for (const text of bad) assert.equal(await code(s.call('answer', s.discord.post(text))), 'INVALID', text);
  assert.deepEqual(s.facade.names(), []);
});

test('answer: wrong person, closed quiz, wrong round, two quizzes and replays are refused', async t => {
  const s = setup(t, { specs: [quiz(3, 'AAP864', { round: 2 })] });
  assert.equal(await code(s.call('answer', s.discord.post('Q1: A', { author: { id: OTHER } }))), 'REFUSED');
  const old = idAt(NOW - 20 * MIN);
  inbox.bindPost(s.db, { messageId: old, channelId: CHANNEL, project: 'AAP864', specId: 3, kind: 'quiz', version: 1 }, NOW);
  assert.equal(await code(s.call('answer', s.discord.post('Q1: A', s.discord.replyTo(old)))), 'STALE');
  const early = s.discord.post('Q1: B', {}, NOW - 5 * MIN);
  assert.equal(await code(s.call('answer', s.discord.post('Q1: A'))), 'ok');
  assert.equal(await code(s.call('answer', early)), 'STALE');
  assert.equal(s.facade.of('saveDraft').length, 1);
  const two = setup(t, { specs: [quiz(3), quiz(4)] });
  assert.equal(await code(two.call('answer', two.discord.post('Q1: A'))), 'CHOOSE');
  two.facade.saveDraft = async () => false;
  two.facade.views.delete(4);
  assert.equal(await code(two.call('answer', two.discord.post('Q1: A'))), 'STATE');
});

test('dry run makes no POST at all and records what it would reply', async t => {
  const s = setup(t, { specs: [review(1)] });
  await s.call('submit', s.discord.post(SPEC_URL));
  await s.call('approve', say(s, 'duyệt'));
  assert.deepEqual(s.discord.posts(), []);
  assert.equal(s.would.length, 2);
  assert.match(s.would[1].content, /đã duyệt bản aaaaaaaa/);
});

test('live replies to the message; a failing reply does not undo the action', async t => {
  const s = setup(t, { specs: [review(1)], projects: [project('AAP864', { live: true })] });
  await s.call('submit', s.discord.post(SPEC_URL));
  assert.deepEqual(s.discord.posts().map(c => c.path.split('/').pop()), ['threads', 'messages']);
  await s.call('submit', s.discord.post(SPEC_URL, { channel_id: THREAD }), THREAD);
  assert.equal(s.discord.posts().at(-1).path, `/channels/${THREAD}/messages`);
  s.discord.state.override = (target, init) => (init.method === 'POST' ? Response.json({}, { status: 500 }) : null);
  assert.equal(await code(s.call('approve', say(s, 'duyệt'))), 'ok');
  assert.ok(s.logs.some(line => line.event === 'desk-reply-failed'));
});

test('a dead session loses nothing: pending keeps unacked messages with what was already done', async t => {
  const s = setup(t, { specs: [review(1)] });
  const [used, waiting] = [say(s, 'duyệt', {}, NOW - 2 * MIN), s.discord.post('chào', { author: { id: OTHER } })];
  inbox.collect(s.db, CHANNEL, [s.discord.messages.get(waiting), s.discord.messages.get(used)], NOW);
  await s.call('approve', used);
  const next = s.open();
  const { result } = await next.call('pending', {});
  assert.deepEqual(result.messages.map(m => [m.message_id, m.used_for]), [[used, 'approve'], [waiting, null]]);
  assert.match(result.messages[0].outcome, /đã duyệt/);
  assert.equal((await next.call('approve', { message_id: used, channel_id: CHANNEL })).error.code, 'USED');
  for (const message_id of [used, waiting]) await next.call('ack', { message_id, channel_id: CHANNEL });
  assert.equal((await next.call('pending', {})).result.total, 0);
  assert.equal(s.facade.of('approve').length, 1);
});

test('ack needs a real message of the channel and works before the message was collected', async t => {
  const s = setup(t);
  const id = s.discord.post('chào');
  assert.equal(await code(s.call('ack', idAt(NOW))), 'REFUSED');
  assert.equal(await code(s.call('ack', id, ELSEWHERE)), 'REFUSED');
  assert.equal(await code(s.call('ack', id)), 'ok');
  assert.equal(await code(s.call('ack', id, ELSEWHERE)), 'REFUSED');
  inbox.collect(s.db, CHANNEL, [s.discord.messages.get(id)], NOW);
  assert.equal(inbox.pendingCount(s.db), 0);
});

test('status is read only, shows only the projects of the channel and no links', async t => {
  const s = setup(t, { projects: [project('AAP864'), project('ZZZ999', { channel: ELSEWHERE })], specs: [review(1), review(2, 'ZZZ999')] });
  const overview = s.facade.overview;
  s.facade.overview = async now => {
    const data = await overview(now);
    data.specs.forEach(spec => Object.assign(spec, { link: 'http://x/review/secret' }));
    return data;
  };
  const { result } = await s.call('status', s.discord.post('tới đâu rồi'));
  assert.deepEqual(result, { projects: [{ key: 'AAP864', specs: [{ id: 1, title: 'S1', state: 'review' }], waits: [], jobs: [] }] });
  assert.deepEqual(s.facade.names(), []);
  assert.ok(s.discord.calls.every(c => c.method === 'GET'));
  assert.equal((await s.call('status', idAt(NOW - MIN), '900000000000000099')).error.code, 'REFUSED');
});

test('the bot token is in no log, database row, reply or result', async t => {
  const s = setup(t, { specs: [review(1)] });
  const results = [await s.call('approve', say(s, 'duyệt')), await s.call('submit', s.discord.post('x')), await s.desk.call('pending', {})];
  const rows = s.db.prepare('SELECT * FROM inbox').all();
  assert.ok(!JSON.stringify([results, s.logs, rows, s.would]).includes(TOKEN));
});
