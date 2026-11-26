const inbox = require('./inbox.cjs');
const store = require('./specs/store.cjs');
const { isSnowflake } = require('./discord-bot.cjs');
const { firstLine } = require('./redact.cjs');

const LINK = /\/(quiz|review)\/([\w-]{16,200})$/;

async function versionOf(facade, kind, specId) {
  const view = await facade[kind](specId);
  return kind === 'quiz' ? view?.round : view?.sha;
}

async function bindPosted(ctx, project, group, result, now) {
  if (project.live !== true || !result.ok || !ctx.facade || !isSnowflake(result.messageId) || !isSnowflake(result.channelId)) return;
  const marks = group.waitIds.map(() => '?').join(',');
  const links = ctx.db.prepare(`SELECT link FROM waits WHERE id IN (${marks}) AND link IS NOT NULL`).all(...group.waitIds).map(row => row.link);
  const found = [];
  for (const link of new Set(links.filter(item => group.content.includes(item)))) {
    const match = link.match(LINK);
    if (!match) continue;
    const [, kind, token] = match;
    try {
      const specId = store.resolveToken(ctx.db, token, kind, now);
      const version = specId === null ? null : await versionOf(ctx.facade, kind, specId);
      if (version !== null && version !== undefined && version !== '') found.push({ specId, kind, version });
    } catch (error) {
      ctx.log('bind-post-failed', { project: project.key, kind, error: firstLine(error) });
    }
  }
  if (found.length !== 1) return;
  inbox.bindPost(ctx.db, { messageId: result.messageId, channelId: result.channelId, project: project.key, ...found[0] }, now);
}

module.exports = { bindPosted };
