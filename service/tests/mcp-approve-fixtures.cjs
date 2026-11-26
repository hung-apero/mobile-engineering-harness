const assert = require('node:assert/strict');
const inbox = require('../src/inbox.cjs');
const { NOW, MIN, CHANNEL, SHA, idAt } = require('./mcp-fixtures.cjs');

const bind = (db, specId, version = SHA, time = NOW - 10 * MIN, extra = {}) => {
  const messageId = idAt(time);
  inbox.bindPost(db, { messageId, channelId: CHANNEL, project: 'AAP864', specId, kind: 'review', version, ...extra }, time);
  return messageId;
};

const say = (s, text, extra = {}, time = NOW - MIN, bound = {}) => {
  const channelId = extra.channel_id ?? CHANNEL;
  const post = bind(s.db, bound.specId ?? 1, bound.version ?? SHA, time - MIN, { channelId, project: bound.project ?? 'AAP864' });
  return s.discord.post(text, { ...s.discord.replyTo(post, channelId), ...extra }, time);
};

const refused = async (s, id, code, channelId) => {
  const result = await s.call('approve', id, channelId);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
  assert.deepEqual(s.facade.names(), []);
  return result.error;
};

module.exports = { bind, say, refused };
