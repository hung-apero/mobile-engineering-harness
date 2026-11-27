const fs = require('node:fs');
const { discordLive } = require('./discord-live.cjs');
const path = require('node:path');
const kv = require('./kv.cjs');
const { workingDayKey } = require('./work-hours.cjs');
const { duePings, recordPing, recordPingFailure } = require('./pings.cjs');
const { digest, weeklyMissing, markReportSent } = require('./decisions.cjs');
const { dryWaitIds } = require('./bugs/dry-traces.cjs');
const { logChanged } = require('./service-log.cjs');
const { firstLine } = require('./redact.cjs');
const { bindPosted } = require('./ping-bind.cjs');

const RETRY_MS = 60000;
const webhookFile = (ctx, key) => path.join(ctx.secretsDir, `${key}.discord-webhook`);

function hasWebhook(ctx, key) {
  return fs.lstatSync(webhookFile(ctx, key), { throwIfNoEntry: false }) !== undefined;
}

function noteMissing(ctx, key, now) {
  const day = workingDayKey(now);
  if (kv.get(ctx.db, `no-webhook:${key}`) === day) return;
  kv.set(ctx.db, `no-webhook:${key}`, day, now);
  ctx.log('no-webhook', { project: key });
}

function noteWould(ctx, key, now) {
  const day = workingDayKey(now);
  if (kv.get(ctx.db, `would-notify:${key}`) === day) return;
  kv.set(ctx.db, `would-notify:${key}`, day, now);
  ctx.log('would', { project: key, action: 'discord' });
}

async function send(ctx, key, { content, mentions = [] }, now) {
  try {
    return await ctx.send({ webhookFile: webhookFile(ctx, key), content, mentions });
  } catch (error) {
    return { ok: false, retryAt: now + RETRY_MS, error: firstLine(error) };
  }
}

async function sendPing(ctx, project, group, now) {
  const key = project.key;
  recordPingFailure(ctx.db, group.waitIds, now + RETRY_MS);
  const result = await send(ctx, key, group, now);
  if (result.ok) {
    recordPing(ctx.db, group.waitIds, now);
    await bindPosted(ctx, project, group, result, now);
  } else recordPingFailure(ctx.db, group.waitIds, result.retryAt);
  ctx.log(result.ok ? 'ping-sent' : 'ping-failed', { project: key, role: group.role, waits: group.waitIds.length, error: result.error });
}

async function sendReport(ctx, kind, key, reportProject, content, now) {
  const retryKey = `report-retry:${kind}:${reportProject ?? ''}`;
  if ((kv.get(ctx.db, retryKey) ?? 0) > now) return;
  kv.set(ctx.db, retryKey, now + RETRY_MS, now);
  const result = await send(ctx, key, { content }, now);
  if (result.ok) {
    markReportSent(ctx.db, kind, reportProject, now);
    kv.del(ctx.db, retryKey);
  } else kv.set(ctx.db, retryKey, result.retryAt, now);
  ctx.log(result.ok ? 'report-sent' : 'report-failed', { kind, project: key, error: result.error });
}

async function notifyProject(ctx, project, now) {
  const { key } = project;
  const { rules } = ctx.rulesFor(key);
  const groups = duePings(ctx.db, { project, rules, now, skip: project.live === true ? dryWaitIds(ctx.db, key) : undefined });
  const summary = digest(ctx.db, { project, now });
  if (!groups.length && !summary) return;
  if (!discordLive(project)) {
    noteWould(ctx, key, now);
    return;
  }
  if (!hasWebhook(ctx, key)) {
    noteMissing(ctx, key, now);
    return;
  }
  for (const group of groups) if (!ctx.stopping) await sendPing(ctx, project, group, now);
  if (summary && !ctx.stopping) await sendReport(ctx, 'digest', key, key, summary, now);
}

async function notifyWeekly(ctx, projects, now) {
  const content = weeklyMissing(ctx.db, { now });
  if (!content) return;
  const target = projects.find(project => discordLive(project) && hasWebhook(ctx, project.key));
  if (target) await sendReport(ctx, 'weekly', target.key, null, content, now);
  else if (projects.some(project => !discordLive(project))) noteWould(ctx, 'weekly', now);
  else noteMissing(ctx, 'weekly', now);
}

async function notify(ctx, projects, now) {
  const active = [...projects.values()].filter(project => project.schedulable);
  const guarded = async (project, fn) => {
    try {
      if (!ctx.stopping) await fn();
      logChanged(ctx, `notify:${project}`, null);
    } catch (error) {
      logChanged(ctx, `notify:${project}`, { project, error: firstLine(error) }, 'notify-error');
    }
  };
  await Promise.all(active.map(project => guarded(project.key, () => notifyProject(ctx, project, now))));
  await guarded(null, () => notifyWeekly(ctx, active, now));
}

module.exports = { notify };
