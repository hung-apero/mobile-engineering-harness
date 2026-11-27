const inbox = require('./inbox.cjs');
const { isSnowflake } = require('./discord-bot.cjs');
const { allowedByChannel } = require('../channels/access.cjs');
const { firstLine } = require('./redact.cjs');

const PAGE = 100;
const MAX_PAGES = 5;
const MAX_THREADS = 20;
const THREAD_AGE_MS = 7 * 24 * 3600 * 1000;
const RETRY_MS = 3600 * 1000;
const UNKNOWN_MS = 3600 * 1000;
const PLAIN_TYPES = new Set([0, 19]);
const DISCORD_EPOCH = 1420070400000;

const snowflakeAt = ms => String(BigInt(ms - DISCORD_EPOCH) << 22n);

const newest = (a, b) => (BigInt(a) > BigInt(b) ? a : b);

function threadIds(db, now, channels) {
  const since = now - THREAD_AGE_MS;
  const rows = db.prepare(
    `SELECT id, MAX(at) AS at FROM (
       SELECT channel_id AS id, at FROM inbox_posts WHERE at >= ?
       UNION ALL SELECT channel_id, seen_at FROM inbox WHERE seen_at >= ?
       UNION ALL SELECT message_id, seen_at FROM inbox WHERE seen_at >= ? AND action = 'submit'
     ) GROUP BY id ORDER BY at DESC`,
  ).all(since, since, since);
  return rows.map(row => row.id).filter(id => isSnowflake(id) && !channels.has(id));
}

function createReconciler({ db, bot, log = () => {} }) {
  const parents = new Map();
  const retryAt = new Map();
  const guilds = new Map();
  let turn = 0;

  async function parentOf(id, now) {
    if (parents.has(id)) return parents.get(id);
    if ((retryAt.get(id) ?? 0) > now) return null;
    try {
      const parent = (await bot.channel(id))?.parent_id ?? null;
      if (parent) parents.set(id, parent);
      else retryAt.set(id, now + RETRY_MS);
      return parent;
    } catch (error) {
      if (!['NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) throw error;
      retryAt.set(id, now + RETRY_MS);
      return null;
    }
  }

  async function guildOf(channelId) {
    if (!guilds.has(channelId)) guilds.set(channelId, (await bot.channel(channelId)).guild_id);
    return guilds.get(channelId);
  }

  async function findActive(channelId) {
    const threads = await bot.activeThreads(await guildOf(channelId));
    const own = threads.filter(thread => thread?.parent_id === channelId && isSnowflake(thread.id));
    for (const { id } of own) parents.set(id, channelId);
    return own.map(thread => thread.id);
  }

  function nextTurn(ids) {
    const start = turn < ids.length ? turn : 0;
    turn = start + MAX_THREADS;
    return ids.slice(start, start + MAX_THREADS);
  }

  async function readChannel(id, allowed, start, now) {
    if (inbox.cursorOf(db, id) === null) inbox.collect(db, id, [{ id: start }], now);
    let added = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const list = await bot.messagesAfter(id, inbox.cursorOf(db, id), PAGE);
      const wanted = list.map(message => (allowed.includes(message?.author?.id) && PLAIN_TYPES.has(message.type) ? message : { id: message?.id }));
      added += inbox.collect(db, id, wanted, now);
      if (list.length < PAGE) break;
    }
    return added;
  }

  async function reconcile(projects, now) {
    const channels = allowedByChannel(projects);
    const threads = () => [...parents].filter(([, parent]) => channels.has(parent)).map(([id, parent]) => ({ id, parent }));
    const active = new Set();
    let added = 0;
    const guarded = async (id, work) => {
      try {
        await work();
        return true;
      } catch (error) {
        log('desk-reconcile-failed', { channelId: id, code: error?.code ?? 'INTERNAL', error: firstLine(error) });
        return error?.code !== 'RATE_LIMITED';
      }
    };
    for (const [id, allowed] of channels) {
      const go = await guarded(id, async () => {
        added += await readChannel(id, allowed, snowflakeAt(now), now);
      });
      if (!go) return { added, threads: threads(), complete: false };
    }
    for (const id of channels.keys()) {
      const go = await guarded(id, async () => {
        for (const thread of await findActive(id)) active.add(thread);
      });
      if (!go) return { added, threads: threads(), complete: false };
    }
    const known = threadIds(db, now, channels);
    for (const id of nextTurn([...new Set([...known, ...active])])) {
      const go = await guarded(id, async () => {
        const parent = await parentOf(id, now);
        if (!channels.has(parent)) return;
        added += await readChannel(id, channels.get(parent), known.includes(id) ? id : newest(id, snowflakeAt(now - UNKNOWN_MS)), now);
      });
      if (!go) return { added, threads: threads(), complete: false };
    }
    return { added, threads: threads(), complete: true };
  }

  return { reconcile };
}

module.exports = { createReconciler, snowflakeAt };
