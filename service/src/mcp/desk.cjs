const inbox = require('../inbox.cjs');
const { redact } = require('../redact.cjs');
const { scrub } = require('../../channels/private-text.cjs');
const { DeskError, toPublic } = require('./desk-error.cjs');
const { validateCall } = require('./tools.cjs');
const { readMessage } = require('./verify.cjs');
const { submit, answer, approve } = require('./actions.cjs');

const LIMIT = 20;

const rows = (value, key, fields) => (Array.isArray(value) ? value : []).filter(row => row.project === key).slice(0, LIMIT)
  .map(row => Object.fromEntries(fields.map(field => [field, typeof row[field] === 'string' ? scrub(redact(row[field])) : row[field] ?? null])));

async function status(deps, args, now) {
  const { candidates, raw, channelId } = await readMessage(deps, args, now);
  if (inbox.record(deps.db, raw, channelId, now).channelId !== channelId) throw new DeskError('REFUSED', 'Tin đã ghi ở kênh khác.');
  const overview = (await deps.facade.overview(now)) ?? {};
  return {
    projects: candidates.map(({ key }) => ({
      key,
      specs: rows(overview.specs, key, ['id', 'title', 'state']),
      waits: rows(overview.waits, key, ['role', 'subject']),
      jobs: rows(overview.jobs, key, ['kind', 'key', 'state']),
    })),
  };
}

async function pending(deps) {
  const messages = inbox.pendingOfOneChannel(deps.db).map(row => ({
    message_id: row.messageId, channel_id: row.channelId, author_id: row.authorId, sent_at: new Date(row.sentAt).toISOString(),
    untrusted_text: scrub(row.text), used_for: row.action, outcome: row.outcome,
  }));
  return { total: inbox.pendingCount(deps.db), messages };
}

async function ack(deps, args, now) {
  const { message_id: messageId, channel_id: channelId } = args;
  if (!inbox.rowOf(deps.db, messageId)) {
    const message = await readMessage(deps, args, now);
    inbox.record(deps.db, message.raw, channelId, now);
  }
  if (!inbox.ack(deps.db, messageId, channelId, now)) throw new DeskError('REFUSED', 'Tin này không thuộc kênh đã nêu.');
  return { acked: true };
}

const TOOLS = { submit, answer, approve, status, pending, ack };

function createDesk({ db, bot, facade, projects, log = () => {}, now = Date.now }) {
  const deps = { db, bot, facade, projects, log };

  async function call(name, rawArgs) {
    try {
      const args = validateCall(name, rawArgs);
      const result = await TOOLS[name](deps, args, now());
      log('desk', { tool: name, ...args, outcome: result.outcome ?? 'ok' });
      return { ok: true, result };
    } catch (error) {
      const shown = toPublic(error);
      log('desk-refused', { tool: String(name).slice(0, 20), code: shown.code, message: shown.message, ...(shown.code === 'INTERNAL' && { detail: String(error?.name) }) });
      return { ok: false, error: shown };
    }
  }

  return { call };
}

module.exports = { createDesk };
