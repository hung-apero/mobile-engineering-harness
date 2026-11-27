const kv = require('../kv.cjs');
const { resolveWait } = require('../pings.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { loadIssue } = require('./issue-view.cjs');
const { listTickets } = require('./store.cjs');
const { baseContains } = require('./release.cjs');
const { waitStatusKey } = require('./outcome.cjs');
const { isRefused } = require('./jira-refusal.cjs');

const INTERVAL_MS = 5 * 60 * 1000;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const checkedKey = project => `bug-waits-check:${project}`;

function close(ctx, project, wait, reason, now) {
  if (!resolveWait(ctx.db, wait.id, now)) return;
  record(ctx.db, { project: project.key, code: 'P01', ruleVersion: ruleVersionOf(ctx, project.key), evidence: { waitId: wait.id, reason }, action: 'wait-auto-closed' }, now);
}

async function readableIssue(jira, key) {
  try {
    return await loadIssue(jira, key);
  } catch (error) {
    if (isRefused(error)) return null;
    throw error;
  }
}

async function closeTicketWaits(ctx, project, jira, open, now) {
  const { inProgress, resolved, done } = project.jiraStatus;
  for (const key of kv.keys(ctx.db, `bug-waits:${project.key}:`)) {
    const ids = (kv.get(ctx.db, key) ?? []).filter(id => open.has(id));
    if (!ids.length) continue;
    const ticket = key.slice(key.lastIndexOf(':') + 1);
    const issue = await readableIssue(jira, ticket);
    if (!issue) continue;
    const { status } = issue;
    const openedAt = kv.get(ctx.db, waitStatusKey(project.key, ticket)) ?? {};
    const finished = [...done, resolved].some(name => same(name, status));
    const moved = id => openedAt[id] && !same(openedAt[id], status) && !same(status, inProgress);
    for (const id of ids) if (finished || moved(id)) close(ctx, project, open.get(id), `ticket ${status}`, now);
  }
}

async function allChecked(ctx, project, jira, version) {
  const delivered = listTickets(ctx.db, { project: project.key, version, states: ['done'] }).filter(ticket => ticket.verdict === 'fixed');
  for (const { key } of delivered) {
    const issue = await readableIssue(jira, key);
    if (!issue || same(issue.status, project.jiraStatus.resolved)) return false;
  }
  return true;
}

async function closeVersionWaits(ctx, project, jira, version, open, now) {
  const merge = [...open.values()].filter(w => w.subject.startsWith(`Merge PR ${version.branch} (`));
  if (merge.length && (await (ctx.bugs.baseContains ?? baseContains)(ctx, project, version)).ok) {
    for (const wait of merge) close(ctx, project, wait, 'nhánh gốc đã chứa bản', now);
  }
  const check = [...open.values()].filter(w => w.subject === `Kiểm bản cài ${project.key} ${version.version}`);
  if (!check.length || !(await allChecked(ctx, project, jira, version.version))) return;
  for (const wait of check) close(ctx, project, wait, 'không còn ticket Resolved của bản', now);
}

async function closeStaleWaits(ctx, project, versions, now) {
  if (now - (kv.get(ctx.db, checkedKey(project.key)) ?? 0) < INTERVAL_MS) return;
  const rows = ctx.db.prepare("SELECT * FROM waits WHERE project = ? AND state = 'open'").all(project.key);
  kv.set(ctx.db, checkedKey(project.key), now, now);
  if (!rows.length) return;
  const open = new Map(rows.map(row => [row.id, row]));
  const jira = await ctx.bugs.jira(project);
  await closeTicketWaits(ctx, project, jira, open, now);
  for (const version of versions) await closeVersionWaits(ctx, project, jira, version, open, now);
}

module.exports = { closeStaleWaits };
