const test = require('node:test');
const assert = require('node:assert/strict');
const inbox = require('../src/inbox.cjs');
const { createReconciler, snowflakeAt } = require('../src/desk-reconcile.cjs');
const { BotError } = require('../src/discord-bot.cjs');
const { NOW, MIN, GUILD, CHANNEL, THREAD, ELSEWHERE, PO, idAt, project, deskHome, message } = require('./desk-fixtures.cjs');

function fakeBot(messages = {}, extra = {}) {
  const calls = [];
  return {
    calls,
    channel: async id => {
      calls.push(['channel', id]);
      if (id === CHANNEL || (id === ELSEWHERE && extra.elsewhere)) return { id, guild_id: GUILD };
      if (id === THREAD) return { id, parent_id: CHANNEL };
      throw new BotError('NOT_FOUND', 'x');
    },
    activeThreads: async () => [],
    messagesAfter: async (id, after, limit) => {
      calls.push(['after', id, after]);
      const list = (messages[id] ?? []).filter(item => BigInt(item.id) > BigInt(after)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      return list.slice(0, limit).reverse();
    },
    ...extra,
  };
}

function setup(t, bot) {
  const h = deskHome(t);
  const logs = [];
  const reconciler = createReconciler({ db: h.db, bot, log: (event, fields) => logs.push({ event, ...fields }) });
  const run = (now = NOW, projects = [project('AAA')]) => reconciler.reconcile(projects, now);
  return { ...h, logs, run };
}

const seen = (db, now = NOW) => inbox.collect(db, CHANNEL, [{ id: snowflakeAt(now - 10 * MIN) }], now);

test('first sight of a channel starts from now, old history is not queued', async t => {
  const h = setup(t, fakeBot({ [CHANNEL]: [message(idAt(NOW - MIN))] }));
  assert.deepEqual(await h.run(), { added: 0, threads: [], complete: true });
  assert.equal(inbox.cursorOf(h.db, CHANNEL), snowflakeAt(NOW));
});

test('messages after the last seen id become pending once', async t => {
  const id = idAt(NOW - MIN);
  const h = setup(t, fakeBot({ [CHANNEL]: [message(idAt(NOW - 20 * MIN)), message(id)] }));
  seen(h.db);
  assert.equal((await h.run()).added, 1);
  assert.deepEqual(inbox.pending(h.db).map(row => row.messageId), [id]);
  assert.equal((await h.run(NOW + MIN)).added, 0);
  assert.equal(inbox.cursorOf(h.db, CHANNEL), id);
});

test('a message the session already acked stays acked', async t => {
  const item = message(idAt(NOW - MIN));
  const h = setup(t, fakeBot({ [CHANNEL]: [item] }));
  seen(h.db);
  inbox.record(h.db, item, CHANNEL, NOW);
  inbox.ack(h.db, item.id, CHANNEL, NOW);
  await h.run();
  assert.deepEqual(inbox.pending(h.db), []);
});

test('bots, system messages and people the channel does not allow are passed over', async t => {
  const list = [message(idAt(NOW - 4 * MIN), { author: { id: '623456789012345678' } }), message(idAt(NOW - 3 * MIN), { author: { id: PO, bot: true } }), message(idAt(NOW - 2 * MIN), { type: 18 })];
  const h = setup(t, fakeBot({ [CHANNEL]: list }));
  seen(h.db);
  await h.run();
  assert.deepEqual(inbox.pending(h.db), []);
  assert.equal(inbox.cursorOf(h.db, CHANNEL), list[2].id);
});

test('more than one page is read until it is short', async t => {
  const h = setup(t, fakeBot({ [CHANNEL]: Array.from({ length: 150 }, (_, i) => message(idAt(NOW - 9 * MIN + i))) }));
  seen(h.db);
  assert.equal((await h.run()).added, 150);
});

test('a known thread under a project channel is read from its start', async t => {
  const item = message(idAt(NOW - MIN));
  const h = setup(t, fakeBot({ [THREAD]: [item] }));
  inbox.bindPost(h.db, { messageId: idAt(NOW - 5 * MIN), channelId: THREAD, project: 'AAA', specId: 1, kind: 'quiz', version: 1 }, NOW);
  const result = await h.run();
  assert.deepEqual(result.threads, [{ id: THREAD, parent: CHANNEL }]);
  assert.deepEqual(inbox.pending(h.db).map(row => [row.messageId, row.channelId]), [[item.id, THREAD]]);
});

test('a thread of another channel or a deleted one is skipped and not asked again soon', async t => {
  const bot = fakeBot({ [ELSEWHERE]: [message(idAt(NOW - MIN))] });
  const h = setup(t, bot);
  inbox.bindPost(h.db, { messageId: idAt(NOW), channelId: ELSEWHERE, project: 'AAA', specId: 1, kind: 'quiz', version: 1 }, NOW);
  assert.deepEqual((await h.run()).threads, []);
  await h.run(NOW + MIN);
  assert.equal(bot.calls.filter(call => call[0] === 'channel' && call[1] === ELSEWHERE).length, 1);
  assert.ok(!bot.calls.some(call => call[0] === 'after' && call[1] === ELSEWHERE));
});

test('rate limit stops the round, other errors only skip that channel', async t => {
  const failing = code => fakeBot({}, { elsewhere: true, messagesAfter: async id => { throw new BotError(code, 'x'); } });
  const projects = [project('AAA'), project('BBB', { channel: ELSEWHERE })];
  const limited = setup(t, failing('RATE_LIMITED'));
  assert.equal((await limited.run(NOW, projects)).complete, false);
  assert.equal(limited.logs.length, 1);
  const forbidden = setup(t, failing('FORBIDDEN'));
  assert.equal((await forbidden.run(NOW, projects)).complete, true);
  assert.equal(forbidden.logs.length, 2);
});
