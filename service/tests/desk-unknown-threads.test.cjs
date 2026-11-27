const { test } = require('node:test');
const assert = require('node:assert/strict');
const inbox = require('../src/inbox.cjs');
const { createReconciler } = require('../src/desk-reconcile.cjs');
const { BotError } = require('../src/discord-bot.cjs');
const { NOW, MIN, CHANNEL, ELSEWHERE, GUILD, idAt, project, deskHome, message } = require('./desk-fixtures.cjs');

const DAY = 24 * 60 * MIN;

function reconcileWorld(t, { messages = {}, active = [], fail = null } = {}) {
  const h = deskHome(t);
  const read = [];
  const bot = {
    channel: async id => (id === CHANNEL ? { id, guild_id: GUILD } : { id, parent_id: CHANNEL }),
    activeThreads: async guild => {
      assert.equal(guild, GUILD);
      if (fail) throw new BotError(fail, 'x');
      return active;
    },
    messagesAfter: async (id, after) => {
      read.push(id);
      return (messages[id] ?? []).filter(item => BigInt(item.id) > BigInt(after));
    },
  };
  const reconciler = createReconciler({ db: h.db, bot });
  return { ...h, read, run: (now = NOW) => reconciler.reconcile([project('AAA')], now) };
}

test('Minor: a thread nobody used yet is found and its recent messages become pending', async t => {
  const old = message(idAt(NOW - 3 * DAY));
  const item = message(idAt(NOW - MIN));
  const thread = idAt(NOW - 5 * DAY);
  const h = reconcileWorld(t, { messages: { [thread]: [old, item] }, active: [{ id: thread, parent_id: CHANNEL }, { id: idAt(NOW), parent_id: ELSEWHERE }] });
  const result = await h.run();
  assert.deepEqual(inbox.pending(h.db).map(row => row.messageId), [item.id]);
  assert.deepEqual(result.threads, [{ id: thread, parent: CHANNEL }]);
});

test('Minor: more than 20 threads are read in turns', async t => {
  const active = Array.from({ length: 30 }, (_, i) => ({ id: idAt(NOW - DAY + i * MIN), parent_id: CHANNEL }));
  const h = reconcileWorld(t, { active });
  await h.run();
  await h.run(NOW + MIN);
  assert.equal(new Set(h.read.filter(id => id !== CHANNEL)).size, 30);
});

test('Minor: not being allowed to list threads only logs; the round goes on', async t => {
  const h = reconcileWorld(t, { fail: 'FORBIDDEN' });
  assert.equal((await h.run()).complete, true);
});
