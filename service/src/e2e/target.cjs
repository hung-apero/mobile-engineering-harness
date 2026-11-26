const { runGit, refSha, isAncestor, pathsFor, checkBase } = require('../bugs/git.cjs');
const { treeOf } = require('./builds.cjs');

async function firstParents(git, mirror, tip, base) {
  const { stdout } = await git(['rev-list', '--first-parent', '--reverse', '--parents', base, `^${tip}`], { gitDir: mirror });
  return stdout.split('\n').filter(Boolean).map(row => row.split(' ')).map(([sha, parent]) => ({ sha, parent }));
}

async function mergePoint(git, mirror, tip, base) {
  const line = await firstParents(git, mirror, tip, base);
  let [low, high] = [0, line.length - 1];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (await isAncestor(git, mirror, tip, line[middle].sha)) high = middle;
    else low = middle + 1;
  }
  const found = line[low];
  return !found || found.parent === tip ? tip : found.sha;
}

async function releaseTarget(ctx, project, version, git = runGit) {
  const branch = version.branch ?? `dz/release-${version.version}`;
  const { mirror } = pathsFor({ dzHome: ctx.dzHome, project });
  const tip = await refSha(git, mirror, `refs/heads/${branch}`);
  if (!tip) return null;
  const base = await refSha(git, mirror, `refs/heads/${checkBase(project.base)}`);
  const merged = base !== null && await isAncestor(git, mirror, tip, base);
  const sha = merged ? await mergePoint(git, mirror, tip, base) : tip;
  return { sha, tree: await treeOf({ dzHome: ctx.dzHome, project, sha, git }) };
}

module.exports = { releaseTarget };
