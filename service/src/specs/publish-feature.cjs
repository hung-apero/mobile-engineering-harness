const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('../redact.cjs');
const { makeTmp } = require('../bugs/publish.cjs');
const { GitError, runGit, runGh, check, checkBase, pathsFor, githubUrlOf, remoteSha, SHA } = require('../bugs/git.cjs');

const FEATURE = /^dz\/feature-[A-Z][A-Z0-9]+-[1-9]\d{0,8}$/;
const featureBranch = ({ project, id }) => check(FEATURE, `dz/feature-${project.key}-${id}`, 'nhánh tính năng');

async function pushFeature({ dzHome, project, branch, sha, githubUrl, live, record, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  check(FEATURE, branch, 'nhánh tính năng');
  check(SHA, sha, 'sha');
  const url = githubUrlOf(project, githubUrl);
  if (live !== true) {
    record('would', `git push ${sha}:refs/heads/${branch} (${project.repo})`);
    return { pushed: true, dryRun: true, branch, sha };
  }
  if ((await remoteSha(git, mirror, url, branch)) === sha) return { pushed: false, branch, sha };
  await git(['push', '--quiet', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--', url, `${sha}:refs/heads/${branch}`], { gitDir: mirror, remote: true });
  if ((await remoteSha(git, mirror, url, branch)) !== sha) throw new GitError('GitHub không nhận đúng commit sau khi push', 'PUSH_UNVERIFIED');
  return { pushed: true, branch, sha };
}

async function ensureDraftPr({ dzHome, project, branch, title, body, live, record, gh = runGh }) {
  const { tmp } = pathsFor({ dzHome, project });
  const head = check(FEATURE, branch, 'nhánh tính năng');
  const base = checkBase(project.base);
  githubUrlOf(project);
  if (live !== true) {
    record('would', `gh pr create --draft ${head} -> ${base} (${project.repo})`);
    return { number: null, url: null, created: true, dryRun: true };
  }
  const dir = await makeTmp(tmp);
  try {
    const common = ['--repo', project.repo, '--head', head, '--base', base];
    const find = async () => JSON.parse((await gh(['pr', 'list', ...common, '--state', 'open', '--json', 'number,url,isDraft'], { cwd: dir })).stdout)[0];
    const open = await find();
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, redact(body), { mode: 0o600 });
    if (open) {
      await gh(['pr', 'edit', String(open.number), '--repo', project.repo, '--body-file', bodyFile], { cwd: dir });
      return { number: open.number, url: open.url, created: false };
    }
    await gh(['pr', 'create', ...common, '--draft', `--title=${redact(title)}`, '--body-file', bodyFile], { cwd: dir });
    const made = await find();
    if (!made) throw new GitError('gh không trả về PR vừa tạo', 'PR_UNVERIFIED');
    return { number: made.number, url: made.url, created: true };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { featureBranch, pushFeature, ensureDraftPr };
