const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');
const inbox = require('../src/inbox.cjs');
const { NOW, MIN, CHANNEL, ELSEWHERE, PO, idAt } = require('./mcp-fixtures.cjs');

const message = (id, extra = {}) => ({ id, channel_id: CHANNEL, author: { id: PO }, content: 'chào', ...extra });

function setup(t) {
  const dir = fs.mkdtempSync(path.join('/private/tmp', 'dzi-'));
  const file = path.join(dir, 'dz.db');
  const db = openDb(file);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { db, file };
}

test('a message id is claimed once, by one action, even across restarts', t => {
  const { db, file } = setup(t);
  const id = idAt(NOW);
  inbox.record(db, message(id), CHANNEL, NOW);
  assert.equal(inbox.claim(db, id, { action: 'approve', specId: 1 }, NOW), true);
  assert.equal(inbox.claim(db, id, { action: 'approve', specId: 1 }, NOW), false);
  assert.equal(inbox.claim(db, id, { action: 'submit' }, NOW), false);
  db.close();
  const again = openDb(file);
  inbox.record(again, message(id), CHANNEL, NOW + MIN);
  assert.equal(inbox.claim(again, id, { action: 'answer', specId: 1 }, NOW), false);
  again.close();
});

test('claiming an unknown message fails', t => {
  assert.equal(inbox.claim(setup(t).db, idAt(NOW), { action: 'approve' }, NOW), false);
});

test('release only frees a claim that has no outcome', t => {
  const { db } = setup(t);
  const id = idAt(NOW);
  inbox.record(db, message(id), CHANNEL, NOW);
  inbox.claim(db, id, { action: 'approve', specId: 1 }, NOW);
  inbox.release(db, id);
  assert.equal(inbox.claim(db, id, { action: 'approve', specId: 1 }, NOW), true);
  inbox.finish(db, id, 'xong');
  inbox.release(db, id);
  assert.equal(inbox.claim(db, id, { action: 'approve', specId: 1 }, NOW), false);
});

test('pending lists messages that were never acked, oldest first, until acked', t => {
  const { db } = setup(t);
  const [first, second] = [idAt(NOW - 5 * MIN), idAt(NOW - MIN)];
  inbox.collect(db, CHANNEL, [message(second), message(first)], NOW);
  assert.deepEqual(inbox.pending(db).map(row => row.messageId), [first, second]);
  assert.equal(inbox.ack(db, first, ELSEWHERE, NOW), false);
  assert.equal(inbox.ack(db, first, CHANNEL, NOW), true);
  assert.equal(inbox.ack(db, first, CHANNEL, NOW + MIN), true);
  assert.equal(inbox.rowOf(db, first).ackedAt, NOW);
  assert.deepEqual(inbox.pending(db).map(row => row.messageId), [second]);
  assert.equal(inbox.pendingCount(db), 1);
});

test('overdue reports messages unacked for two minutes', t => {
  const { db } = setup(t);
  const id = idAt(NOW);
  inbox.record(db, message(id), CHANNEL, NOW);
  assert.deepEqual(inbox.overdue(db, NOW + 2 * MIN - 1), []);
  assert.deepEqual(inbox.overdue(db, NOW + 2 * MIN).map(row => row.messageId), [id]);
  inbox.ack(db, id, CHANNEL, NOW);
  assert.deepEqual(inbox.overdue(db, NOW + 9 * MIN), []);
});

test('collect keeps only people, remembers the newest id and never brings back acked messages', t => {
  const { db } = setup(t);
  const [person, bot, hook] = [idAt(NOW), idAt(NOW + 1), idAt(NOW + 2)];
  const page = [message(person), message(bot, { author: { id: PO, bot: true } }), message(hook, { webhook_id: '1' }), { id: 'x' }, null];
  assert.equal(inbox.collect(db, CHANNEL, page, NOW), 1);
  assert.equal(inbox.cursorOf(db, CHANNEL), hook);
  inbox.ack(db, person, CHANNEL, NOW);
  assert.equal(inbox.collect(db, CHANNEL, page, NOW), 0);
  assert.deepEqual(inbox.pending(db), []);
  inbox.collect(db, CHANNEL, [message(idAt(NOW - 60 * MIN))], NOW);
  assert.equal(inbox.cursorOf(db, CHANNEL), hook);
});

test('collect that fails half way keeps neither rows nor cursor', t => {
  const { db } = setup(t);
  const broken = message(idAt(NOW + 1));
  Object.defineProperty(broken, 'content', { get: () => { throw new Error('hỏng'); } });
  assert.throws(() => inbox.collect(db, CHANNEL, [message(idAt(NOW)), broken], NOW), /hỏng/);
  assert.equal(inbox.cursorOf(db, CHANNEL), null);
  assert.deepEqual(inbox.pending(db), []);
});

test('stored text is redacted and cut', t => {
  const { db } = setup(t);
  const id = idAt(NOW);
  inbox.record(db, message(id, { content: `ghp_${'a'.repeat(30)} ${'x'.repeat(5000)}` }), CHANNEL, NOW);
  const { text } = inbox.rowOf(db, id);
  assert.ok(!text.includes('ghp_'));
  assert.ok(text.length <= 2000);
});

test('a bound post cannot be rebound to another version', t => {
  const { db } = setup(t);
  const id = idAt(NOW);
  const base = { messageId: id, channelId: CHANNEL, project: 'AAP864', specId: 1, kind: 'review' };
  inbox.bindPost(db, { ...base, version: 'one' }, NOW);
  inbox.bindPost(db, { ...base, version: 'two' }, NOW);
  assert.equal(inbox.postOf(db, id).version, 'one');
});
