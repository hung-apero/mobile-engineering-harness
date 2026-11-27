const kv = require('../kv.cjs');
const store = require('./store.cjs');
const { recordWould } = require('./effects.cjs');

const nextKey = (project, version) => `base-watch-next:${project}:${version}`;
const prsOf = (db, project, version) => store.listBatches(db, { project, version }).map(batch => batch.data.pr).filter(Boolean);

function lastPr(db, project, { version, branch }) {
  const next = kv.get(db, nextKey(project, version));
  if (!next || next.branch !== branch) return prsOf(db, project, version).at(-1) ?? null;
  return prsOf(db, project, version).filter(pr => !next.oldPrs.includes(pr.number)).at(-1) ?? next.pr ?? null;
}

function noteNext(db, project, version, { branch, sha, carried }, now) {
  const oldPrs = prsOf(db, project, version).map(pr => pr.number);
  const before = kv.get(db, nextKey(project, version));
  if (before?.pr) oldPrs.push(before.pr.number);
  kv.set(db, nextKey(project, version), { branch, sha, carried, oldPrs, pr: null, done: false }, now);
}

async function publishNext(ctx, project, version, now) {
  const { db, dzHome } = ctx;
  const key = nextKey(project.key, version.version);
  const next = kv.get(db, key);
  if (project.live !== true || !next || next.done || next.branch !== version.branch) return false;
  if (store.listBatches(db, { project: project.key, version: version.version, states: ['running'] }).length) return false;
  if (lastPr(db, project.key, version)) {
    kv.set(db, key, { ...next, done: true }, now);
    return false;
  }
  const { merge } = ctx.bugs.git;
  const args = { dzHome, project, versionBranch: next.branch, live: true, record: recordWould(ctx, project), githubUrl: ctx.bugs.githubUrl };
  await merge.pushVersion({ ...args, sha: next.sha });
  const pr = next.carried
    ? await merge.ensurePr({ ...args, gh: ctx.bugs.gh, title: `dz: bản ${version.version}`, body: `PR của bản ${version.version} sau khi nhánh trước bị squash, gồm phần chưa vào nhánh gốc.` })
    : null;
  kv.set(db, key, { ...next, pr: pr && { number: pr.number, url: pr.url }, done: true }, now);
  return true;
}

module.exports = { lastPr, noteNext, publishNext, nextKey };
