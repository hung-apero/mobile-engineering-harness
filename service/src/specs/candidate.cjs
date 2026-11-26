const fs = require('node:fs');
const path = require('node:path');
const { runGit, check, pathsFor, checkBase, refSha, isAncestor, requireRef, GitError, LANE, SHA } = require('../bugs/git.cjs');
const { makeTmp } = require('../bugs/publish.cjs');
const { checkRepo } = require('./wire.cjs');
const { DIR } = require('./repo-files.cjs');

const FORBIDDEN = [DIR, `${DIR}/**`, `**/${DIR}/**`];
const MAX_LINES = 20000;
const INTEGRATION = /^dz\/spec-[1-9]\d{0,14}$/;

const out = async promise => (await promise).stdout.trim();

async function commitLeftovers({ repo, git = runGit }) {
  await checkRepo(repo);
  const branch = await out(git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }));
  if (!INTEGRATION.test(branch)) throw new GitError(`bản clone không ở nhánh dz/spec-<id>: ${branch}`, 'INVALID');
  const paths = ['--', '.', `:(exclude)${DIR}`];
  if (await out(git(['status', '--porcelain', ...paths], { cwd: repo }))) {
    await git(['add', '-A', ...paths], { cwd: repo });
    await git(['commit', '-q', '--no-verify', '-m', 'chore: leftover changes', ...paths], { cwd: repo });
  }
  return check(SHA, await out(git(['rev-parse', 'HEAD'], { cwd: repo })), 'HEAD');
}

async function fetchHead({ mirror, repo, id, head, git }) {
  const ref = `refs/dz/spec-${id}`;
  await git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--', repo, `+HEAD:${ref}`], { gitDir: mirror });
  if ((await refSha(git, mirror, ref)) !== head) throw new GitError('nhánh của spec vừa đổi trong lúc lấy code', 'MOVED');
}

async function startOf({ mirror, base, versionBranch, head, git }) {
  const commonWith = async other => {
    const found = await git(['merge-base', head, other], { gitDir: mirror, okCodes: [0, 1] });
    return found.code === 0 ? check(SHA, found.stdout.trim(), 'start') : null;
  };
  const fromBase = await commonWith(await requireRef(git, mirror, base));
  if (!fromBase) throw new GitError('code tính năng không chung gốc với nhánh gốc', 'INVALID');
  const tip = versionBranch ? await refSha(git, mirror, `refs/heads/${versionBranch}`) : null;
  const fromVersion = tip && await commonWith(tip);
  return fromVersion && await isAncestor(git, mirror, fromBase, fromVersion) ? fromVersion : fromBase;
}

async function strippedTree({ mirror, tmp, head, start, git }) {
  const dir = await makeTmp(tmp);
  const tree = path.join(dir, 'tree');
  try {
    await git(['worktree', 'add', '--quiet', '--detach', '--no-checkout', '--', tree, head], { gitDir: mirror });
    await git(['read-tree', head], { cwd: tree });
    await git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', `:(top,icase)${DIR}`], { cwd: tree });
    const old = await out(git(['ls-tree', '-d', '--name-only', start, '--', DIR], { cwd: tree }));
    if (old) await git(['read-tree', `--prefix=${DIR}/`, `${start}:${DIR}`], { cwd: tree });
    return check(SHA, await out(git(['write-tree'], { cwd: tree })), 'tree');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await git(['worktree', 'prune'], { gitDir: mirror });
  }
}

async function parentsOf({ mirror, start, prev, git }) {
  if (!prev) return [start];
  return (await isAncestor(git, mirror, start, prev)) ? [prev] : [prev, start];
}

async function makeCandidate({ dzHome, project, repo, id, n, prev = null, versionBranch = null, message, git = runGit }) {
  const { mirror, tmp } = pathsFor({ dzHome, project });
  const branch = check(LANE, `fix/spec-${id}-${n}`, 'nhánh candidate');
  const head = await commitLeftovers({ repo, git });
  await fetchHead({ mirror, repo, id, head, git });
  const start = await startOf({ mirror, base: checkBase(project.base), versionBranch, head, git });
  const tree = await strippedTree({ mirror, tmp, head, start, git });
  const parents = await parentsOf({ mirror, start, prev, git });
  const sameAsPrev = prev && parents.length === 1 && (await out(git(['rev-parse', `${prev}^{tree}`], { gitDir: mirror }))) === tree;
  const sha = sameAsPrev ? prev : check(SHA, await out(git(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message], { gitDir: mirror })), 'sha');
  await git(['update-ref', '-m', 'dev-zone candidate', `refs/heads/${branch}`, sha], { gitDir: mirror });
  return { n, branch, sha, head, start };
}

async function mergeBase({ dzHome, project, a, b, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  return check(SHA, await out(git(['merge-base', check(SHA, a, 'a'), check(SHA, b, 'b')], { gitDir: mirror })), 'merge-base');
}

module.exports = { makeCandidate, mergeBase, FORBIDDEN, MAX_LINES };
