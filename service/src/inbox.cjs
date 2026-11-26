const { transaction, get, set } = require('./kv.cjs');
const { redact } = require('./redact.cjs');
const { isSnowflake, snowflakeTime } = require('./discord-bot.cjs');

const MAX_TEXT = 2000;
const PENDING_LIMIT = 50;
const OVERDUE_MS = 2 * 60 * 1000;

const cursorKey = channelId => `desk:cursor:${channelId}`;

function toRow(row) {
  if (!row) return null;
  return {
    messageId: row.message_id, channelId: row.channel_id, authorId: row.author_id, text: row.text, sentAt: row.sent_at,
    seenAt: row.seen_at, ackedAt: row.acked_at, action: row.action, specId: row.spec_id, claimedAt: row.claimed_at, outcome: row.outcome,
  };
}

const isHuman = message => Boolean(message?.author) && !message.author.bot && !message.author.system && !message.webhook_id;

function insert(db, message, channelId, now) {
  return db.prepare(
    `INSERT INTO inbox (message_id, channel_id, author_id, text, sent_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (message_id) DO NOTHING`,
  ).run(message.id, channelId, message.author.id, redact(message.content ?? '').slice(0, MAX_TEXT), snowflakeTime(message.id), now).changes === 1;
}

function rowOf(db, messageId) {
  return toRow(db.prepare('SELECT * FROM inbox WHERE message_id = ?').get(messageId));
}

function record(db, message, channelId, now) {
  insert(db, message, channelId, now);
  return rowOf(db, message.id);
}

const cursorOf = (db, channelId) => get(db, cursorKey(channelId));

function collect(db, channelId, messages, now) {
  return transaction(db, () => {
    let newest = cursorOf(db, channelId);
    let added = 0;
    for (const message of messages) {
      if (!isSnowflake(message?.id)) continue;
      if (newest === null || BigInt(message.id) > BigInt(newest)) newest = message.id;
      if (isHuman(message) && insert(db, message, channelId, now)) added += 1;
    }
    if (newest !== null) set(db, cursorKey(channelId), newest, now);
    return added;
  });
}

function claim(db, messageId, { action, specId = null }, now) {
  return db.prepare('UPDATE inbox SET action = ?, spec_id = ?, claimed_at = ? WHERE message_id = ? AND action IS NULL')
    .run(action, specId, now, messageId).changes === 1;
}

function release(db, messageId) {
  db.prepare('UPDATE inbox SET action = NULL, spec_id = NULL, claimed_at = NULL WHERE message_id = ? AND outcome IS NULL').run(messageId);
}

function newerUsed(db, specId, messageId) {
  return db.prepare('SELECT message_id FROM inbox WHERE spec_id = ?').all(specId).some(row => BigInt(row.message_id) > BigInt(messageId));
}

function finish(db, messageId, outcome) {
  db.prepare('UPDATE inbox SET outcome = ? WHERE message_id = ? AND action IS NOT NULL').run(outcome, messageId);
}

function ack(db, messageId, channelId, now) {
  const row = rowOf(db, messageId);
  if (!row || row.channelId !== channelId) return false;
  db.prepare('UPDATE inbox SET acked_at = ? WHERE message_id = ? AND acked_at IS NULL').run(now, messageId);
  return true;
}

function pending(db, limit = PENDING_LIMIT) {
  return db.prepare('SELECT * FROM inbox WHERE acked_at IS NULL ORDER BY sent_at, message_id LIMIT ?').all(limit).map(toRow);
}

function pendingOfOneChannel(db, limit = PENDING_LIMIT) {
  const [first] = pending(db, 1);
  if (!first) return [];
  return db.prepare('SELECT * FROM inbox WHERE acked_at IS NULL AND channel_id = ? ORDER BY sent_at, message_id LIMIT ?').all(first.channelId, limit).map(toRow);
}

function pendingCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE acked_at IS NULL').get().n;
}

function overdue(db, now, ms = OVERDUE_MS) {
  return db.prepare('SELECT * FROM inbox WHERE acked_at IS NULL AND seen_at <= ? ORDER BY sent_at, message_id').all(now - ms).map(toRow);
}

function bindPost(db, { messageId, channelId, project, specId, kind, version }, now) {
  db.prepare(
    `INSERT INTO inbox_posts (message_id, channel_id, project, spec_id, kind, version, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (message_id) DO NOTHING`,
  ).run(messageId, channelId, project, specId, kind, String(version), now);
}

function toPost(row) {
  if (!row) return null;
  return { messageId: row.message_id, channelId: row.channel_id, project: row.project, specId: row.spec_id, kind: row.kind, version: row.version, at: row.at };
}

function postOf(db, messageId) {
  return toPost(db.prepare('SELECT * FROM inbox_posts WHERE message_id = ?').get(messageId));
}

function firstPost(db, { specId, kind, version }) {
  return toPost(db.prepare('SELECT * FROM inbox_posts WHERE spec_id = ? AND kind = ? AND version = ? ORDER BY at LIMIT 1').get(specId, kind, String(version)));
}

module.exports = {
  record, rowOf, collect, cursorOf, claim, release, newerUsed, finish, ack, pending, pendingOfOneChannel, pendingCount, overdue,
  bindPost, postOf, firstPost, isHuman, OVERDUE_MS,
};
