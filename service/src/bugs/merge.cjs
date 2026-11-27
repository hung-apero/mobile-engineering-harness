const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('../redact.cjs');
const { GitError, runGit, check, checkBase, pathsFor, refSha, isAncestor, requireRef, SHA, LANE, VERSION_BRANCH } = require('./git.cjs');
const { makeTmp, pushVersion, ensurePr } = require('./publish.cjs');

async function withWorktree(git, { mirror, tmp }, sha, work) {
  const dir = await makeTmp(tmp);
  const tree = path.join(dir, 'tree');
  try {
    await git(['worktree', 'add', '--quiet', '--detach', '--', tree, sha], { gitDir: mirror });
    return await work(tree);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
    await git(['worktree', 'prune'], { gitDir: mirror });
  }
}

const headOf = async (git, tree) => (await git(['rev-parse', 'HEAD'], { cwd: tree })).stdout.trim();

async function applyOrAbort(git, tree, args) {
  const before = await headOf(git, tree);
  const result = await git(args, { cwd: tree, okCodes: [0, 1] });
  if (result.code === 0) {
    const sha = await headOf(git, tree);
    return { sha, changed: sha !== before };
  }
  const listed = await git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: tree });
  const files = [...new Set(listed.stdout.split('\0').filter(Boolean))];
  if (files.length === 0) throw new GitError(`git ${args[0]} thất bại mà không có xung đột: ${redact(result.stderr).trim().slice(0, 300)}`, 'GIT_FAILED');
  await git([args[0], '--abort'], { cwd: tree });
  return { files };
}

const mergeCommit = (git, tree, sha, message) =>
  applyOrAbort(git, tree, ['merge', '--no-ff', '--no-edit', '--no-stat', '--no-verify', '-m', message, sha]);

async function moveRef(git, mirror, branch, next, before) {
  const ref = `refs/heads/${branch}`;
  try {
    await git(['update-ref', '-m', 'dev-zone', ref, next, before], { gitDir: mirror });
  } catch (error) {
    if ((await refSha(git, mirror, ref)) === before) throw error;
    throw new GitError(`nhánh ${branch} đã đổi trong lúc gộp`, 'REF_MOVED');
  }
}

async function mergesOnFirstParent(git, mirror, tip) {
  const { stdout } = await git(['rev-list', '--first-parent', '--merges', '--parents', tip], { gitDir: mirror });
  return stdout.split('\n').filter(Boolean).map(row => row.split(' '));
}

async function findRevert(git, mirror, mergeSha, tip) {
  const { stdout } = await git(['rev-list', '--first-parent', '--fixed-strings', `--grep=This reverts commit ${mergeSha}`, `${mergeSha}..${tip}`], { gitDir: mirror });
  return stdout.split('\n')[0] || null;
}

async function inspectLane(git, mirror, entry, { start, before }) {
  const { branch, commit } = typeof entry === 'string' ? { branch: entry } : entry;
  const skip = (code, extra) => ({ skip: { branch, code, ...extra } });
  if (typeof branch !== 'string' || !LANE.test(branch)) return skip('invalid_name');
  const sha = await refSha(git, mirror, `refs/heads/${branch}`);
  if (!sha) return skip('missing');
  if (commit !== undefined && commit !== sha) return skip('moved');
  if (await isAncestor(git, mirror, sha, before)) {
    const hit = (await mergesOnFirstParent(git, mirror, before)).find(row => row[2] === sha);
    if (!hit) return skip('no_diff');
    const reverted = await findRevert(git, mirror, hit[0], before);
    return skip(reverted ? 'reverted' : 'already_merged', { mergeSha: hit[0] });
  }
  if (!(await isAncestor(git, mirror, start, sha))) return skip('not_descendant');
  const diff = await git(['diff', '--quiet', '--no-ext-diff', start, sha], { gitDir: mirror, okCodes: [0, 1] });
  return diff.code === 0 ? skip('no_diff') : { branch, sha };
}

async function mergeBatch({ dzHome, project, versionBranch, branches, startSha, skipConflicting = false, git = runGit }) {
  const paths = pathsFor({ dzHome, project });
  const { mirror } = paths;
  check(VERSION_BRANCH, versionBranch, 'nhánh version');
  const base = checkBase(project.base);
  const before = await requireRef(git, mirror, versionBranch);
  const baseSha = await requireRef(git, mirror, base);
  const start = startSha === undefined ? before : check(SHA, startSha, 'startSha');
  if (!(await isAncestor(git, mirror, start, before))) throw new GitError('startSha không thuộc nhánh version', 'INVALID');
  const lanes = [];
  const skipped = [];
  for (const entry of branches) {
    const lane = await inspectLane(git, mirror, entry, { start, before });
    if (lane.skip) skipped.push(lane.skip);
    else lanes.push(lane);
  }
  const unchanged = { ok: true, before, sha: before, baseMerge: null, merged: [], skipped };
  if (lanes.length === 0) return unchanged;

  const result = await withWorktree(git, paths, before, async tree => {
    const pulled = await mergeCommit(git, tree, baseSha, `merge: ${base} into ${versionBranch}`);
    if (pulled.files) return { ok: false, conflictsWith: 'base', files: pulled.files, skipped };
    const merged = [];
    for (const { branch, sha } of lanes) {
      const done = await mergeCommit(git, tree, sha, `merge: ${branch} into ${versionBranch}`);
      if (done.files && !skipConflicting) return { ok: false, conflictsWith: branch, files: done.files, skipped };
      if (done.files) skipped.push({ branch, code: 'conflict', files: done.files });
      else if (!done.changed) skipped.push({ branch, code: 'no_diff' });
      else merged.push({ branch, commit: sha, mergeSha: done.sha });
    }
    if (merged.length === 0) return unchanged;
    const sha = merged[merged.length - 1].mergeSha;
    return { ok: true, before, sha, baseMerge: pulled.changed ? pulled.sha : null, merged, skipped };
  });
  if (result.ok && result.sha !== before) await moveRef(git, mirror, versionBranch, result.sha, before);
  return result;
}

async function revertMerge({ dzHome, project, versionBranch, mergeSha, git = runGit }) {
  const paths = pathsFor({ dzHome, project });
  const { mirror } = paths;
  check(VERSION_BRANCH, versionBranch, 'nhánh version');
  check(SHA, mergeSha, 'mergeSha');
  const before = await requireRef(git, mirror, versionBranch);
  const merges = await mergesOnFirstParent(git, mirror, before);
  if (!merges.some(row => row[0] === mergeSha)) throw new GitError('mergeSha không phải lần gộp trên nhánh version', 'INVALID');
  const earlier = await findRevert(git, mirror, mergeSha, before);
  if (earlier) return { ok: true, already: true, before, sha: before, revertSha: earlier };
  const result = await withWorktree(git, paths, before, tree => applyOrAbort(git, tree, ['revert', '--no-edit', '-m', '1', mergeSha]));
  if (result.files) return { ok: false, conflictsWith: mergeSha, files: result.files };
  await moveRef(git, mirror, versionBranch, result.sha, before);
  return { ok: true, already: false, before, sha: result.sha, revertSha: result.sha };
}

module.exports = { mergeBatch, revertMerge, pushVersion, ensurePr };
