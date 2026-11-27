const bugs = require('../bugs/store.cjs');
const { scopeOf, PROJECT_RE } = require('../bugs/polling.cjs');
const { fixVersionNames } = require('../bugs/fix-versions.cjs');
const { replaceBugs, syncOf, saveSync } = require('./store.cjs');
const { logChanged } = require('../service-log.cjs');
const { firstLine } = require('../redact.cjs');

const EVERY_MS = 15 * 60 * 1000;
const LIMIT = 200;
const MAX_TEXT = 300;

const nameOf = value => (value && typeof value === 'object' ? value.displayName ?? value.name ?? null : value ?? null);
const text = (value, max = MAX_TEXT) => (value === null || value === undefined ? null : String(value).replace(/[\p{C}\s]+/gu, ' ').trim().slice(0, max).toWellFormed());

function boardJql(project, { baselineAt, fixVersions }) {
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) throw new Error(`mã project không hợp lệ: ${project}`);
  const { reasons } = scopeOf(fixVersions, baselineAt);
  return `project = ${project} AND issuetype = Bug AND (${reasons.join(' OR ')})\nORDER BY priority DESC, updated DESC`;
}

const toBug = raw => ({
  key: text(raw.key, 40), summary: text(raw.summary) ?? '', status: text(nameOf(raw.status), 60) ?? '?', priority: text(nameOf(raw.priority), 40),
  assignee: text(nameOf(raw.assignee), 120), updatedAt: text(raw.updated, 40),
});

async function syncVersion(ctx, project, version, now) {
  const before = syncOf(ctx.db, project.key, version.version);
  try {
    const jira = await ctx.bugs.jira(project);
    const fixVersions = await fixVersionNames(ctx, project, jira, version.version, now);
    const found = await jira.search(boardJql(project.key, { baselineAt: version.baselineAt ?? now, fixVersions }), { limit: LIMIT });
    const list = found.map(toBug).filter(bug => bug.key);
    replaceBugs(ctx.db, { project: project.key, version: version.version, bugs: list }, now);
    saveSync(ctx.db, project.key, version.version, { at: now, ok: true, count: list.length, capped: found.length >= LIMIT }, now);
  } catch (error) {
    const lastOkAt = before?.ok ? before.at : before?.lastOkAt ?? null;
    saveSync(ctx.db, project.key, version.version, { at: now, ok: false, error: firstLine(error), lastOkAt }, now);
    logChanged(ctx, `board-sync:${project.key}:${version.version}`, { project: project.key, version: version.version, error: firstLine(error) }, 'board-sync-error');
  }
}

const due = (ctx, project, version, now) => version.state === 'open' && version.polling && now - (syncOf(ctx.db, project.key, version.version)?.at ?? -Infinity) >= EVERY_MS;

async function runBoard(ctx, config, now) {
  for (const project of [...config.projects.values()].filter(item => item.schedulable)) {
    for (const version of bugs.listVersions(ctx.db, project.key)) {
      if (!ctx.stopping && due(ctx, project, version, now)) await syncVersion(ctx, project, version, now);
    }
  }
}

function boardStep(ctx, config, now) {
  if (ctx.boardStepPending) return ctx.boardStepPending;
  ctx.boardStepPending = runBoard(ctx, config, now)
    .catch(error => logChanged(ctx, 'board-sync', { error: firstLine(error) }, 'board-sync-error'))
    .finally(() => { ctx.boardStepPending = null; });
  return ctx.boardStepPending;
}

module.exports = { boardStep, boardJql, EVERY_MS };
