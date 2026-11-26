const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const inbox = require('../src/inbox.cjs');
const { readApproval } = require('../src/mcp/approval-text.cjs');
const { readAnswers } = require('../src/mcp/answer-text.cjs');
const { decide } = require('../channels/reply-guard.cjs');
const { prepare, writeAccess, deskPaths, CHANNELS_DIR } = require('../src/desk-config.cjs');
const { NOW, MIN, CHANNEL, THREAD, ELSEWHERE, PO, OTHER, SHA, TOKEN, idAt, project, review, quiz, setup, deskHome, message } = require('./desk-fixtures.cjs');
const { setupWatch } = require('./desk-watch-fixtures.cjs');

const bind = (s, specId = 1, extra = {}) => {
  const messageId = idAt(NOW - 10 * MIN);
  inbox.bindPost(s.db, { messageId, channelId: CHANNEL, project: 'AAP864', specId, kind: 'review', version: SHA, ...extra }, NOW);
  return messageId;
};
const reply = (s, text, extra = {}) => s.discord.post(text, { ...s.discord.replyTo(bind(s)), ...extra });
const one = () => ({ specs: [review(1)] });

test('F6: an approval that names or addresses somebody else is not an approval', () => {
  for (const text of ['<@123456789012345678> duyệt nhé', 'duyệt nhé <@123456789012345678>', '<@&700000000000000001> duyệt', 'anh duyệt nhé', 'chị duyệt nhé', 'em duyệt nhé', 'bạn duyệt nhé', 'team duyệt rồi', 'ban chot nhe', 'a duyệt nhé', 'duyệt nhé em', 'you approve', 'minh duyet nhe', 'Hà duyệt rồi', '@Hà duyệt']) assert.equal(readApproval(text), 'feedback', text);
  for (const text of ['duyệt', 'mình duyệt nhé', 'tôi đồng ý', 'ok, thank you', 'I approve', 'đã duyệt']) assert.equal(readApproval(text), 'approved', text);
});

test('F6: a delegation replied to the review is feedback, never an approval', async t => {
  const s = setup(t, one());
  const { result } = await s.call('approve', reply(s, `<@${OTHER}> duyệt nhé`));
  assert.equal(result.decision, 'feedback');
  assert.deepEqual(s.facade.of('approve'), []);
});

test('F6: an approval with an attachment, sticker or poll is feedback', async t => {
  for (const extra of [{ attachments: [{ id: '1' }] }, { sticker_items: [{ id: '1' }] }, { poll: {} }]) {
    const s = setup(t, one());
    assert.equal((await s.call('approve', reply(s, 'duyệt', extra))).result.decision, 'feedback');
  }
});

test('F6: an approval that does not reply to the review post is ignored with an explanation and stays usable', async t => {
  const s = setup(t, one());
  const id = s.discord.post('duyệt');
  const { error } = await s.call('approve', id);
  assert.equal(error.code, 'CHOOSE');
  assert.match(error.message, /trả lời/i);
  assert.deepEqual(s.facade.names(), []);
  assert.equal(inbox.rowOf(s.db, id).action, null);
  assert.equal((await s.call('approve', reply(s, 'duyệt'))).result.decision, 'approved');
});

test('F7: chatter that does not reply to a review post never becomes feedback', async t => {
  const s = setup(t, one());
  assert.equal((await s.call('approve', s.discord.post('mai họp lúc 9h nhé'))).error.code, 'CHOOSE');
  assert.equal((await s.call('approve', s.discord.post('sửa màn 2', s.discord.replyTo(bind(s, 1, { kind: 'quiz', version: '1' }))))).error.code, 'CHOOSE');
  assert.deepEqual(s.facade.names(), []);
});

test('F8: pending shows one channel at a time, without tokens and secret links', async t => {
  const s = setup(t, { projects: [project('AAP864'), project('ZZZ999', { channel: ELSEWHERE })] });
  const secret = `${TOKEN} http://127.0.0.1:1/x?t=abcdef0123456789 http://127.0.0.1:1/review/${'k'.repeat(32)}`;
  const [a, b] = [message(idAt(NOW - 3 * MIN), { content: secret }), message(idAt(NOW - 2 * MIN))];
  inbox.collect(s.db, ELSEWHERE, [a], NOW);
  inbox.collect(s.db, CHANNEL, [b], NOW);
  const first = (await s.desk.call('pending', {})).result;
  assert.deepEqual([first.total, first.messages.map(m => m.channel_id)], [2, [ELSEWHERE]]);
  assert.ok(!/secret\.z|t=abc|kkkk/.test(JSON.stringify(first)));
  await s.desk.call('ack', { message_id: a.id, channel_id: ELSEWHERE });
  assert.deepEqual((await s.desk.call('pending', {})).result.messages.map(m => m.message_id), [b.id]);
});

test('F8: status needs a real message of that very channel', async t => {
  const s = setup(t, { projects: [project('AAP864'), project('ZZZ999', { channel: ELSEWHERE })], specs: [review(1)] });
  const id = s.discord.post('tới đâu rồi');
  assert.equal((await s.desk.call('status', { channel_id: ELSEWHERE })).error.code, 'INVALID');
  assert.equal((await s.call('status', id, ELSEWHERE)).error.code, 'REFUSED');
  assert.deepEqual((await s.call('status', id)).result.projects.map(p => p.key), ['AAP864']);
  assert.equal(inbox.rowOf(s.db, id).channelId, CHANNEL);
});

const REPLY = 'mcp__plugin_discord_discord__reply';
const MSG = '900000000000000100';
function verdict(input, { rows = { [MSG]: CHANNEL }, others = [], keys = { [CHANNEL]: ['AAP864'], [ELSEWHERE]: ['ZZZ999'] } } = {}) {
  const inboxView = { channelOf: id => rows[id] ?? null, others: () => others };
  return decide({ tool_name: REPLY, tool_input: input }, { channels: [CHANNEL, ELSEWHERE], keys }, inboxView).hookSpecificOutput.permissionDecision;
}

test('F8: a reply must answer a known message of the same channel', () => {
  const good = { chat_id: CHANNEL, text: 'Đã nhận.', reply_to: MSG };
  assert.equal(verdict(good), 'allow');
  assert.equal(verdict({ chat_id: CHANNEL, text: 'x' }), 'deny');
  assert.equal(verdict({ ...good, reply_to: '900000000000000999' }), 'deny');
  assert.equal(verdict({ ...good, chat_id: ELSEWHERE }), 'deny');
  assert.equal(verdict({ ...good, reply_to: '../x' }), 'deny');
});

test('F8: a reply carrying text of another channel, another project key, a bot token or a secret link is denied', () => {
  const say = (text, extra) => verdict({ chat_id: CHANNEL, text, reply_to: MSG }, extra);
  const others = ['Giá gói năm của app mới là 399 nghìn, chưa công bố'];
  assert.equal(say('Bên kia nói: giá gói năm của app mới là 399 nghìn', { others }), 'deny');
  assert.equal(say('Spec đang chờ duyệt.', { others }), 'allow');
  assert.equal(say('ZZZ999 đang build'), 'deny');
  assert.equal(say('AAP864 đang build'), 'allow');
  for (const text of [TOKEN, 'http://127.0.0.1:4/review?t=abcdef0123456789', `http://127.0.0.1:4/quiz/${'k'.repeat(32)}`]) assert.equal(say(text), 'deny', text);
});

test('F8: the hook command reads the inbox itself and fails closed', t => {
  const h = deskHome(t);
  const paths = prepare(h.home, [project('AAA', { live: true })]);
  const id = idAt(NOW);
  inbox.record(h.db, message(id), CHANNEL, Date.now());
  const run = (input, db = paths.db) => spawnSync(process.execPath, [path.join(CHANNELS_DIR, 'reply-guard.cjs'), paths.replyChannels, db], { input: JSON.stringify({ tool_name: REPLY, tool_input: input }), encoding: 'utf8' });
  const good = run({ chat_id: CHANNEL, text: 'chào', reply_to: id });
  assert.equal(JSON.parse(good.stdout).hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(JSON.parse(run({ chat_id: CHANNEL, text: 'chào', reply_to: idAt(NOW) }).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run({ chat_id: CHANNEL, text: 'chào', reply_to: id }, path.join(h.home, 'none.db')).status, 2);
  assert.ok(!fs.existsSync(path.join(h.home, 'none.db')));
});

const channelsOf = h => JSON.parse(fs.readFileSync(deskPaths(h.home).replyChannels, 'utf8')).channels;

test('F9: turning live off closes the reply channel at the next step, before and without any Discord call', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  await h.step(NOW + 1000);
  assert.deepEqual(channelsOf(h), [CHANNEL, THREAD]);
  h.events.length = 0;
  await h.manager.step([project('AAA', { live: false })], NOW + 2000);
  assert.deepEqual([channelsOf(h), h.names()], [[], []]);
});

test('F9: a rate limited reconcile still applies the config and keeps only cached threads', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  h.state.incomplete = true;
  await h.manager.step([project('AAA', { live: true, people: { po: PO, qa: PO, devOnCall: PO } })], NOW + 5 * MIN);
  const access = JSON.parse(fs.readFileSync(deskPaths(h.home).access, 'utf8'));
  assert.deepEqual(access.groups[CHANNEL].allowFrom, [PO]);
  assert.deepEqual(channelsOf(h), [CHANNEL, THREAD]);
  await h.manager.step([project('AAA', { live: false })], NOW + 10 * MIN);
  assert.deepEqual(channelsOf(h), []);
});

test('F9: switching the desk off closes the reply channels before the session is stopped', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  await h.manager.step([], NOW + 1000);
  assert.deepEqual(channelsOf(h), []);
  writeAccess(h.home, [project('AAA', { live: true })]);
  assert.deepEqual(channelsOf(h), [CHANNEL]);
});

test('Minor: answers from an edited message are refused and a bare "gửi" does not submit', async t => {
  const questions = [{ id: 'Q1', answered: false, options: [{ label: 'A', text: 'x' }] }];
  for (const text of ['gửi', 'gui', 'Gửi nhé']) assert.throws(() => readAnswers(text, questions), { code: 'INVALID' }, text);
  for (const text of ['nộp', 'Nộp nhé', 'gửi quiz', 'submit']) assert.equal(readAnswers(text, questions).submit, true, text);
  const s = setup(t, { specs: [quiz(3)] });
  const id = s.discord.post('Q1: A', { edited_timestamp: '2026-11-25T03:00:00Z' });
  assert.equal((await s.call('answer', id)).error.code, 'REFUSED');
  assert.deepEqual(s.facade.names(), []);
});
