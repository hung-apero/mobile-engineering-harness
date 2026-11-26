const { runGit, refSha, isAncestor, remoteSha, githubUrlOf, pathsFor, checkBase, GitError, SHA, VERSION_BRANCH, ZERO } = require('./git.cjs');

const MAX_NEXT = 50;

const treeOf = async (mirror, sha) => (await runGit(['rev-parse', '--verify', '--end-of-options', `${sha}^{tree}`], { gitDir: mirror })).stdout.trim();

async function mergedTree(mirror, ours, theirs) {
  const out = await runGit(['merge-tree', '--write-tree', '--no-messages', ours, theirs], { gitDir: mirror, okCodes: [0, 1] });
  const tree = out.stdout.split('\n')[0].trim();
  return out.code === 0 && SHA.test(tree) ? tree : null;
}

async function commitTree(mirror, tree, message, parent) {
  const { stdout } = await runGit(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { gitDir: mirror });
  return stdout.trim();
}

async function carriedTree(mirror, baseSha, tip, carry) {
  const root = await commitTree(mirror, await treeOf(mirror, carry), 'carry root');
  const [ours, theirs] = [await commitTree(mirror, await treeOf(mirror, baseSha), 'ours', root), await commitTree(mirror, await treeOf(mirror, tip), 'theirs', root)];
  return mergedTree(mirror, ours, theirs);
}

async function contentInBase(mirror, tip, baseSha) {
  const fork = await runGit(['merge-base', tip, baseSha], { gitDir: mirror, okCodes: [0, 1] });
  if (fork.code !== 0) return false;
  if ((await treeOf(mirror, fork.stdout.trim())) === (await treeOf(mirror, tip))) return false;
  return (await mergedTree(mirror, baseSha, tip)) === (await treeOf(mirror, baseSha));
}

async function squashedPr({ project, version, mirror, tip, baseSha, gh }) {
  const { stdout } = await gh(['pr', 'list', '--repo', project.repo, '--head', version.branch, '--base', checkBase(project.base), '--state', 'merged', '--limit', '5', '--json', 'number,headRefOid,mergeCommit']);
  for (const { number, headRefOid: head, mergeCommit } of JSON.parse(stdout || '[]')) {
    const merged = mergeCommit?.oid;
    if (!SHA.test(head ?? '') || !SHA.test(merged ?? '')) continue;
    if (!(await refSha(runGit, mirror, head)) || !(await refSha(runGit, mirror, merged))) continue;
    if (!(await isAncestor(runGit, mirror, head, tip)) || (await isAncestor(runGit, mirror, head, baseSha))) continue;
    if (await isAncestor(runGit, mirror, merged, baseSha)) return { number, head };
  }
  return null;
}

async function findSquash(args) {
  const { project, mirror, tip, baseSha } = args;
  if (await contentInBase(mirror, tip, baseSha)) return { how: 'tree', tip, baseSha, carry: null };
  if (project.live !== true) return null;
  const pr = await squashedPr(args);
  return pr ? { how: `pr-${pr.number}`, tip, baseSha, carry: pr.head === tip ? null : pr.head } : null;
}

async function freeName(mirror, url, version) {
  for (let n = 2; n <= MAX_NEXT; n += 1) {
    const branch = `dz/release-${version}-${n}`;
    if (!VERSION_BRANCH.test(branch)) break;
    if (!(await refSha(runGit, mirror, `refs/heads/${branch}`)) && !(await remoteSha(runGit, mirror, url, branch))) return branch;
  }
  throw new GitError(`hết tên nhánh kế tiếp cho ${version}`, 'INVALID');
}

async function nextBranch({ ctx, project, version, found }) {
  const { mirror } = pathsFor({ dzHome: ctx.dzHome, project });
  const { tip, baseSha, carry } = found;
  let sha = baseSha;
  if (carry) {
    const tree = await carriedTree(mirror, baseSha, tip, carry);
    if (!tree) return { conflict: true };
    if (tree !== (await treeOf(mirror, baseSha))) {
      sha = await commitTree(mirror, tree, `carry: phần chưa merge của ${version.branch} sau khi squash`, baseSha);
    }
  }
  const branch = await freeName(mirror, githubUrlOf(project, ctx.bugs.githubUrl), version.version);
  await runGit(['update-ref', '-m', 'dev-zone next', `refs/heads/${branch}`, sha, ZERO], { gitDir: mirror });
  return { branch, sha, carried: sha !== baseSha };
}

module.exports = { findSquash, nextBranch, contentInBase };
