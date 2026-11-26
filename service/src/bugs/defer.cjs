const kv = require('../kv.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { fixVersionNames } = require('./fix-versions.cjs');
const { priorityOf } = require('./intake.cjs');
const { toIssue } = require('./issue-view.cjs');
const { isClosed } = require('./closing.cjs');
const store = require('./store.cjs');

const deferKey = (project, version) => `release-defer:${project}:${version}`;
const KEEP_LABEL = 'claude-fix';
const MAX_LIST = 200;
const NAME = /^(?!\s)[^\p{C}]{1,60}(?<!\s)$/u;

class DeferError extends Error {}

const deferred = (db, project, version) => kv.get(db, deferKey(project, version)) ?? [];
const deferredKeys = (db, project, version) => new Set(deferred(db, project, version).map(entry => entry.key));

async function openLow(ctx, project, version, now) {
  const { lowJql } = require('./release.cjs');
  const jira = await ctx.bugs.jira(project);
  const names = await fixVersionNames(ctx, project, jira, version.version, now);
  const found = await jira.search(lowJql(project, version, names, now), { limit: MAX_LIST });
  return found.map(toIssue).filter(issue => store.KEY_RE.test(issue.key));
}

async function deferList(ctx, project, version, now) {
  const known = new Map(deferred(ctx.db, project.key, version.version).map(entry => [entry.key, entry]));
  const open = await openLow(ctx, project, version, now);
  return open.map(({ key, summary, priority, status }) => {
    const entry = known.get(key);
    return { key, summary, priority, status, deferred: Boolean(entry), by: entry?.by ?? null, at: entry?.at ?? null };
  });
}

async function deferTickets(ctx, project, version, { keys, by, source = 'cli' }, now) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_LIST || new Set(keys).size !== keys.length) throw new DeferError('cần danh sách ticket không trùng');
  if (typeof by !== 'string' || !NAME.test(by)) throw new DeferError('cần tên người hoãn');
  const open = new Set((await openLow(ctx, project, version, now)).map(issue => issue.key));
  const strange = keys.filter(key => !open.has(key));
  if (strange.length) throw new DeferError(`không hoãn được ${strange.join(', ')}: chỉ hoãn bug Medium/Low đang mở của bản ${version.version}`);
  const { db } = ctx;
  return kv.transaction(db, () => {
    const known = deferred(db, project.key, version.version);
    const fresh = keys.filter(key => !known.some(entry => entry.key === key));
    kv.set(db, deferKey(project.key, version.version), [...known, ...fresh.map(key => ({ key, by, at: now, source }))], now);
    for (const key of fresh) {
      store.setTicketState(db, project.key, key, 'accepted', 'skipped', now);
      record(db, { project: project.key, code: 'R03', ruleVersion: ruleVersionOf(ctx, project.key), evidence: { version: version.version, key, by, source }, action: 'deferred' }, now);
    }
    return { deferred: fresh, already: keys.filter(key => !fresh.includes(key)) };
  });
}

function takes(ctx, project, version, hit) {
  const issue = toIssue(hit);
  if (issue.labels.includes(KEEP_LABEL)) return true;
  if (priorityOf(issue) < 2) return true;
  if (deferredKeys(ctx.db, project.key, version.version).has(issue.key)) return false;
  if (!isClosed(ctx.db, project.key, version.version)) return true;
  return store.getTicket(ctx.db, project.key, issue.key) !== null;
}

module.exports = { deferList, deferTickets, deferred, deferredKeys, takes, deferKey, DeferError, NAME };
