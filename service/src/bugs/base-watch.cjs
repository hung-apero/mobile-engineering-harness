const kv = require('../kv.cjs');
const store = require('./store.cjs');
const { resolveWait } = require('../pings.cjs');
const { addWorkingMinutes } = require('../work-hours.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf, recordWould } = require('./effects.cjs');
const { openBatchWait } = require('./dry-traces.cjs');
const { runGit, runGh, pathsFor, refSha, isAncestor, checkBase } = require('./git.cjs');
const { findSquash, nextBranch } = require('./squash.cjs');
const { lastPr, noteNext, publishNext } = require('./next-branch.cjs');

const INTERVAL_MS = 15 * 60 * 1000;
const DAY_MINUTES = 540;
const watchKey = (project, version) => `base-watch:${project}:${version}`;

function note(ctx, project, code, action, evidence, now) {
  record(ctx.db, { project: project.key, code, ruleVersion: ruleVersionOf(ctx, project.key), evidence, action }, now);
}

async function oldestCommitAt(mirror, base, tip) {
  const { stdout } = await runGit(['log', '--no-merges', '--format=%ct', `${base}..${tip}`], { gitDir: mirror });
  const times = stdout.split('\n').filter(Boolean).map(Number);
  return times.length ? Math.min(...times) * 1000 : null;
}

function closePings(ctx, project, branch, now) {
  const prefix = `Merge PR ${branch} (`;
  for (const { id, subject } of ctx.db.prepare("SELECT id, subject FROM waits WHERE project = ? AND role = 'dev' AND state = 'open'").all(project.key)) {
    if (subject.startsWith(prefix)) resolveWait(ctx.db, id, now);
  }
}

async function pingOpenPr(ctx, project, version, { mirror, baseSha, tip }, now) {
  const pr = lastPr(ctx.db, project.key, version);
  if (!pr) return;
  const max = ctx.rulesFor(project.key).rules.F07.max_pr_lines;
  const lines = await ctx.bugs.git.landing.diffLines({ dzHome: ctx.dzHome, project, base: project.base, sha: tip });
  const oldest = await oldestCommitAt(mirror, baseSha, tip);
  const old = oldest !== null && addWorkingMinutes(oldest, DAY_MINUTES) <= now;
  if (lines <= max && !old) return closePings(ctx, project, version.branch, now);
  const open = ctx.db.prepare("SELECT subject FROM waits WHERE project = ? AND role = 'dev' AND state = 'open'").all(project.key);
  if (open.some(wait => wait.subject.startsWith(`Merge PR ${version.branch} (`))) return;
  const reason = lines > max ? `quá ${max} dòng` : 'commit cũ nhất quá 1 ngày làm việc';
  const run = { db: ctx.db, project, batch: { version: version.version }, live: project.live === true, now: old ? Math.min(oldest, now) : now };
  openBatchWait(run, { role: 'dev', subject: `Merge PR ${version.branch} (${reason})`, link: pr.url });
  note(ctx, project, 'F07', 'ping-merge', { version: version.version, lines, oldest, pr: pr.url }, now);
}

async function rollOver(ctx, project, version, found, now) {
  const { db } = ctx;
  const name = version.version;
  if (store.listBatches(db, { project: project.key, version: name, states: ['running'] }).length) return false;
  if (project.live !== true) {
    const key = `${watchKey(project.key, name)}:would`;
    if (kv.get(db, key) === found.tip) return false;
    kv.set(db, key, found.tip, now);
    recordWould(ctx, project)('would', `F08: mở nhánh kế tiếp của ${version.branch}`);
    return false;
  }
  const next = await nextBranch({ ctx, project, version, found });
  if (next.conflict) {
    const run = { db, project, batch: { version: name }, live: true, now };
    openBatchWait(run, { role: 'dev', subject: `Nhánh ${version.branch} bị squash nhưng phần chưa merge xung đột với nhánh gốc, cần dev gỡ tay (F08)` });
    return false;
  }
  kv.transaction(db, () => {
    noteNext(db, project.key, name, next, now);
    db.prepare('UPDATE versions SET branch = ? WHERE project = ? AND version = ? AND branch = ?').run(next.branch, project.key, name, version.branch);
    note(ctx, project, 'F08', 'next-branch', { version: name, from: version.branch, to: next.branch, how: found.how, sha: next.sha }, now);
  });
  closePings(ctx, project, version.branch, now);
  await publishNext(ctx, project, store.getVersion(db, project.key, name), now);
  return true;
}

async function watchBase(ctx, project, version, now) {
  const key = watchKey(project.key, version.version);
  if (now - (kv.get(ctx.db, key)?.at ?? 0) < INTERVAL_MS) return false;
  kv.set(ctx.db, key, { at: now }, now);
  await publishNext(ctx, project, version, now);
  const { mirror } = pathsFor({ dzHome: ctx.dzHome, project });
  const tip = await refSha(runGit, mirror, `refs/heads/${version.branch}`);
  const baseSha = await refSha(runGit, mirror, `refs/heads/${checkBase(project.base)}`);
  if (!tip || !baseSha) return false;
  if (await isAncestor(runGit, mirror, tip, baseSha)) return false;
  const found = await findSquash({ ctx, project, version, mirror, tip, baseSha, gh: ctx.bugs.gh ?? runGh });
  if (found) return rollOver(ctx, project, version, found, now);
  await pingOpenPr(ctx, project, version, { mirror, baseSha, tip }, now);
  return false;
}

module.exports = { watchBase, lastPr, watchKey, INTERVAL_MS };
