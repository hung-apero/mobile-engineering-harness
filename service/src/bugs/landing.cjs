const fs = require('node:fs');
const path = require('node:path');
const { GitError, runGit, check, checkBase, pathsFor, githubUrlOf, refSha, isAncestor, remoteSha, requireRef, SHA, VERSION_BRANCH, BATCH_ID } = require('./git.cjs');

const lstat = target => fs.lstatSync(target, { throwIfNoEntry: false });

async function remoteTip(git, mirror, url, branch) {
  const tip = await remoteSha(git, mirror, url, branch);
  if (!tip) return null;
  if (!(await refSha(git, mirror, tip))) {
    await git(['fetch', '--quiet', '--no-tags', '--no-prune', '--no-write-fetch-head', '--no-recurse-submodules', '--', url, `refs/heads/${branch}`], { gitDir: mirror, remote: true });
  }
  return tip;
}

async function isPushed(git, mirror, { url, branch, from, to }) {
  const tip = await remoteTip(git, mirror, url, branch);
  if (!tip) return false;
  if (await isAncestor(git, mirror, from, tip)) return true;
  return (await isAncestor(git, mirror, tip, from)) && !(await isAncestor(git, mirror, tip, to));
}

async function versionTip({ dzHome, project, versionBranch, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  return refSha(git, mirror, `refs/heads/${check(VERSION_BRANCH, versionBranch, 'nhánh version')}`);
}

async function resetVersion({ dzHome, project, versionBranch, from, to, githubUrl, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const branch = check(VERSION_BRANCH, versionBranch, 'nhánh version');
  check(SHA, from, 'from');
  check(SHA, to, 'to');
  const tip = await versionTip({ dzHome, project, versionBranch, git });
  if (tip === to) return { ok: true, already: true, sha: to };
  if (tip !== from) throw new GitError(`nhánh ${branch} không còn ở ${from}`, 'REF_MOVED');
  if (!(await isAncestor(git, mirror, to, from))) throw new GitError('đích không nằm trước commit hiện tại', 'INVALID');
  const url = githubUrlOf(project, githubUrl);
  if (await isPushed(git, mirror, { url, branch, from, to })) throw new GitError(`${from} đã lên GitHub, không lùi nhánh`, 'PUSHED');
  try {
    await git(['update-ref', '-m', 'dev-zone reset', `refs/heads/${branch}`, to, from], { gitDir: mirror });
  } catch (error) {
    if ((await versionTip({ dzHome, project, versionBranch, git })) === from) throw error;
    throw new GitError(`nhánh ${branch} đã đổi trong lúc lùi`, 'REF_MOVED');
  }
  return { ok: true, already: false, sha: to };
}

async function moveVersion(git, mirror, branch, next, before) {
  await git(['update-ref', '-m', 'dev-zone sync', `refs/heads/${branch}`, next, before], { gitDir: mirror });
  return next;
}

async function isPublished({ dzHome, project, versionBranch, sha, githubUrl, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const branch = check(VERSION_BRANCH, versionBranch, 'nhánh version');
  const tip = await remoteTip(git, mirror, githubUrlOf(project, githubUrl), branch);
  if (tip && await isAncestor(git, mirror, sha, tip)) return true;
  return isAncestor(git, mirror, sha, `refs/heads/${checkBase(project.base)}`);
}

async function adoptRemote({ dzHome, project, versionBranch, githubUrl, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const branch = check(VERSION_BRANCH, versionBranch, 'nhánh version');
  const local = await versionTip({ dzHome, project, versionBranch, git });
  const tip = await remoteTip(git, mirror, githubUrlOf(project, githubUrl), branch);
  if (!tip || tip === local) return { ok: true, sha: local };
  if (!(await isAncestor(git, mirror, local, tip))) return { ok: false, sha: local, remote: tip };
  return { ok: true, sha: await moveVersion(git, mirror, branch, tip, local) };
}

async function restoreVersion({ dzHome, project, versionBranch, githubUrl, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const branch = check(VERSION_BRANCH, versionBranch, 'nhánh version');
  const local = await versionTip({ dzHome, project, versionBranch, git });
  if (!local) return { sha: null };
  const target = await remoteTip(git, mirror, githubUrlOf(project, githubUrl), branch) ?? await requireRef(git, mirror, checkBase(project.base));
  return { sha: target === local ? local : await moveVersion(git, mirror, branch, target, local) };
}

async function laneState({ dzHome, project, branch, commit, startSha, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const tip = await refSha(git, mirror, `refs/heads/${branch}`);
  if (!tip) return { ok: false, reason: 'nhánh không có trên mirror' };
  if (tip !== commit) return { ok: false, reason: 'commit khác đầu nhánh trên mirror' };
  if (!(await isAncestor(git, mirror, startSha, commit))) return { ok: false, reason: 'nhánh không tách từ commit gốc của đợt' };
  const { stdout } = await git(['rev-list', '--topo-order', '--parents', `${startSha}..${commit}`], { gitDir: mirror });
  const commits = stdout.split('\n').filter(Boolean).map(row => row.split(' '));
  return { ok: true, commits: commits.map(([sha, parent]) => ({ sha, parent: parent ?? null })) };
}

async function diffLines({ dzHome, project, base, sha, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const { stdout } = await git(['diff', '--shortstat', '--no-ext-diff', `refs/heads/${base}...${check(SHA, sha, 'sha')}`], { gitDir: mirror });
  return ['insertion', 'deletion'].reduce((sum, word) => sum + Number(stdout.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0), 0);
}

function batchDir({ dzHome, project, batchId }) {
  const { batches } = pathsFor({ dzHome, project });
  const dir = path.join(batches, check(BATCH_ID, batchId, 'batch.id'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(dir) !== dir) throw new GitError(`${dir} phải là thư mục thật`, 'UNSAFE_PATH');
  return dir;
}

function copyLocalFiles(project, tree) {
  if (!project.localFiles?.length) return;
  const source = fs.realpathSync(project.checkout);
  for (const name of project.localFiles) {
    const from = path.join(source, name);
    const parts = name.split('/');
    const bad = parts.some(p => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git');
    if (bad || !lstat(from)?.isFile() || fs.realpathSync(from) !== from) throw new GitError(`localFiles ${name}: phải là file thường nằm trong checkout`, 'LOCAL_FILE');
    const parent = path.dirname(path.join(tree, name));
    fs.mkdirSync(parent, { recursive: true });
    if (fs.realpathSync(parent) !== parent) throw new GitError(`localFiles ${name}: thư mục đích là symlink`, 'LOCAL_FILE');
    if (!lstat(path.join(tree, name))) fs.copyFileSync(from, path.join(tree, name), fs.constants.COPYFILE_EXCL);
  }
}

async function changedFiles({ dzHome, project, from, commits, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const files = new Set();
  for (const commit of commits) {
    const { stdout } = await git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', check(SHA, from, 'from'), check(SHA, commit, 'commit')], { gitDir: mirror });
    for (const file of stdout.split('\0').filter(Boolean)) files.add(file);
  }
  return [...files].sort();
}

async function removeWorktree({ dzHome, project, batchId, name = 'gate', git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  await fs.promises.rm(path.join(batchDir({ dzHome, project, batchId }), check(BATCH_ID, name, 'worktree')), { recursive: true, force: true });
  await git(['worktree', 'prune'], { gitDir: mirror });
}

async function versionWorktree({ dzHome, project, batchId, sha, name = 'gate', reuse = false, localFiles = true, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  check(SHA, sha, 'sha');
  const tree = path.join(batchDir({ dzHome, project, batchId }), check(BATCH_ID, name, 'worktree'));
  if (!(reuse && (await moveTree(git, tree, sha)))) {
    await removeWorktree({ dzHome, project, batchId, name, git });
    await git(['worktree', 'add', '--quiet', '--detach', '--', tree, sha], { gitDir: mirror });
  }
  if (localFiles) copyLocalFiles(project, tree);
  return { tree };
}

async function moveTree(git, tree, sha) {
  if (!lstat(tree)?.isDirectory() || !lstat(path.join(tree, '.git'))?.isFile()) return false;
  try {
    await git(['checkout', '--quiet', '--force', '--detach', sha], { cwd: tree });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  resetVersion, versionTip, isPublished, adoptRemote, restoreVersion, laneState, diffLines, changedFiles, versionWorktree, removeWorktree, batchDir,
};
