const kv = require('../kv.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { checkVersion, getVersion, KEY_RE } = require('./store.cjs');
const { fixVersionNames } = require('./fix-versions.cjs');
const { firstLine } = require('../redact.cjs');
const { runGit, refSha, isAncestor } = require('./git.cjs');
const { deferredKeys } = require('./defer.cjs');
const { closeWhenReady } = require('./closing.cjs');
const { afterClose, ownWaits } = require('./release-waits.cjs');
const { sixthCondition } = require('../e2e/state.cjs');

const HOUR = 60 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;
const SAFE_NAME = /^[^"\\\r\n]+$/;
const releaseKey = (project, version) => `bug-release:${project}:${version}`;

const stamp = ms => new Date(ms + 7 * HOUR).toISOString().slice(0, 16).replace('T', ' ');
const quoted = names => {
  if (!names.every(name => typeof name === 'string' && SAFE_NAME.test(name))) throw new Error('tên trạng thái không hợp lệ');
  return names.map(name => `"${name}"`).join(', ');
};

function scopeJql(project, version, baselineAt, names = [version]) {
  checkVersion(version);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(project)) throw new Error(`mã project không hợp lệ: ${project}`);
  const list = names.map(name => `"${name}"`).join(', ');
  const own = names.length ? `fixVersion in (${list}) OR ` : '';
  return `project = ${project} AND issuetype = Bug AND (${own}(fixVersion is EMPTY AND created >= "${stamp(baselineAt)}"))`;
}

async function count(jira, text, label, skip = new Set()) {
  const found = await jira.search(text, { limit: 200 });
  const all = found.map(issue => issue.key).filter(key => KEY_RE.test(key));
  const keys = all.filter(key => !skip.has(key));
  const held = all.length - keys.length;
  const tail = held ? ` (${held} bug đã hoãn)` : '';
  const left = keys.length ? `${label}: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ` và ${keys.length - 5} ticket khác` : ''}` : `không còn ${label}`;
  return { ok: keys.length === 0, detail: `${left}${tail}`, keys };
}

async function baseContains(ctx, project, version) {
  const { workspace } = ctx.bugs.git;
  const { mirror, baseSha } = await workspace.ensureMirror({ dzHome: ctx.dzHome, project, githubUrl: ctx.bugs.githubUrl });
  const tip = await refSha(runGit, mirror, `refs/heads/${version.branch ?? workspace.versionBranch(version.version)}`);
  if (!tip) return { ok: false, detail: 'chưa có nhánh version' };
  const ok = await isAncestor(runGit, mirror, tip, baseSha);
  return { ok, detail: `nhánh gốc ${ok ? 'đã' : 'chưa'} chứa ${tip.slice(0, 8)}` };
}

async function probe(ctx, project, jira, version, now) {
  try {
    return { names: await fixVersionNames(ctx, project, jira, version.version, now) };
  } catch (error) {
    return { failure: { ok: null, detail: `không kiểm được version trên Jira: ${firstLine(error)}` } };
  }
}

const closedNames = ({ jiraStatus }) => quoted([...jiraStatus.done, jiraStatus.resolved]);
const scopeOf = (project, version, names, now) => scopeJql(project.key, version.version, version.baselineAt ?? now, names);
const lowJql = (project, version, names, now) => `${scopeOf(project, version, names, now)} AND priority in (Medium, Low, Lowest) AND status not in (${closedNames(project)})`;

function jiraConditions(ctx, project, jira, version, names, now) {
  const { resolved, reopened } = project.jiraStatus;
  const scope = scopeOf(project, version, names, now);
  return [
    count(jira, `${scope} AND priority in (Highest, High) AND status not in (${closedNames(project)})`, 'bug Highest/High mở'),
    count(jira, `${scope} AND status in (${quoted([resolved, reopened])})`, 'bug Resolved hoặc Reopened'),
    count(jira, lowJql(project, version, names, now), 'bug Medium/Low mở', deferredKeys(ctx.db, project.key, version.version)),
  ];
}

async function assess(ctx, project, version, now) {
  const jira = await ctx.bugs.jira(project);
  const { names, failure } = await probe(ctx, project, jira, version, now);
  const one = await (ctx.bugs.baseContains ?? baseContains)(ctx, project, version);
  const [six, two, three, four] = await Promise.all([
    sixthCondition(ctx, project, version),
    ...(failure ? [failure, failure, failure] : jiraConditions(ctx, project, jira, version, names, now)),
  ]);
  const own = ownWaits(kv.get(ctx.db, releaseKey(project.key, version.version)));
  const waits = ctx.db.prepare("SELECT id FROM waits WHERE project = ? AND role = 'po' AND state = 'open'").all(project.key).filter(wait => !own.has(wait.id));
  const five = { ok: waits.length === 0, detail: waits.length ? `${waits.length} câu hỏi PO chưa trả lời` : 'không có câu hỏi PO nào chờ' };
  const conditions = [one, two, three, four, five, six].map((c, i) => ({ n: i + 1, ok: c.ok, detail: c.detail }));
  const flags = conditions.map(c => c.ok);
  const fixed = flags.slice(1, 5).every(ok => ok === true);
  let ready = 'none';
  if (flags.every(ok => ok === true)) ready = 'release';
  else if (fixed && flags[5] === true && flags[0] !== true) ready = 'merge';
  return { conditions, ready, pendingLow: four.keys ?? [], unknown: Boolean(failure) };
}

function log(ctx, project, code, action, evidence, now) {
  record(ctx.db, { project: project.key, code, ruleVersion: ruleVersionOf(ctx, project.key), evidence, action }, now);
}

async function checkRelease(ctx, project, version, now, { force = false } = {}) {
  const key = releaseKey(project.key, version.version);
  const state = { at: 0, ready: 'none', waits: {}, ...kv.get(ctx.db, key) };
  if (!force && now - state.at < INTERVAL_MS) return null;
  const result = await assess(ctx, project, version, now);
  if (getVersion(ctx.db, project.key, version.version)?.state === 'closed') return null;
  const evidence = { version: version.version, conditions: result.conditions.map(c => c.ok) };
  if (result.unknown) {
    kv.set(ctx.db, key, { ...state, at: now, flags: evidence.conditions }, now);
    return result;
  }
  const name = version.version;
  if (result.ready !== state.ready && result.ready !== 'none') log(ctx, project, 'R01', result.ready === 'merge' ? 'ping-merge' : 'release-ready', evidence, now);
  if (state.ready === 'release' && result.ready !== 'release' && result.conditions[1].ok === false) {
    log(ctx, project, 'R02', 'revoke-release', evidence, now);
    ctx.db.prepare('UPDATE versions SET last_new_at = ? WHERE project = ? AND version = ?').run(now, project.key, name);
  }
  closeWhenReady(ctx, project, version, result.conditions, now);
  afterClose(ctx, project, version, state, result, now);
  kv.set(ctx.db, key, { at: now, ready: result.ready, waits: state.waits, flags: evidence.conditions }, now);
  return result;
}

module.exports = { assess, checkRelease, baseContains, releaseKey, scopeJql, lowJql, INTERVAL_MS };
