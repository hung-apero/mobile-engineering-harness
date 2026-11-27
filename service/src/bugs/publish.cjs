const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('../redact.cjs');
const { GitError, runGit, runGh, check, checkBase, pathsFor, githubUrlOf, refSha, isAncestor, remoteSha, requireRef, SHA, VERSION_BRANCH } = require('./git.cjs');

const STALE_TMP_MS = 24 * 60 * 60 * 1000;

async function makeTmp(tmp) {
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(tmp)) {
    const old = path.join(tmp, name);
    if (Date.now() - fs.lstatSync(old).mtimeMs > STALE_TMP_MS) await fs.promises.rm(old, { recursive: true, force: true });
  }
  return fs.mkdtempSync(path.join(tmp, 'work-'));
}

async function contains(git, mirror, newer, older) {
  return Boolean(await refSha(git, mirror, older)) && isAncestor(git, mirror, older, newer);
}

async function pushVersion({ dzHome, project, versionBranch, sha, githubUrl, live, record, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  check(VERSION_BRANCH, versionBranch, 'nhánh version');
  checkBase(project.base);
  const tip = await requireRef(git, mirror, versionBranch);
  const target = sha === undefined ? tip : check(SHA, sha, 'sha');
  if (!(await isAncestor(git, mirror, target, tip))) throw new GitError('sha không thuộc nhánh version', 'INVALID');
  const url = githubUrlOf(project, githubUrl);
  if (live !== true) {
    record('would', `git push ${target}:refs/heads/${versionBranch} (${project.repo})`);
    return { pushed: true, dryRun: true, branch: versionBranch, sha: target };
  }
  if ((await remoteSha(git, mirror, url, versionBranch)) === target) return { pushed: false, branch: versionBranch, sha: target };
  let failure = null;
  try {
    await git(['push', '--quiet', '--no-verify', '--no-follow-tags', '--recurse-submodules=no', '--', url, `${target}:refs/heads/${versionBranch}`], { gitDir: mirror, remote: true });
  } catch (error) {
    failure = error;
  }
  const remote = await remoteSha(git, mirror, url, versionBranch);
  if (remote !== target) {
    if (remote && !(await contains(git, mirror, target, remote))) throw new GitError(`nhánh ${versionBranch} trên GitHub đã đổi, push không tiến thẳng được`, 'DIVERGED');
    throw failure ?? new GitError('GitHub không nhận đúng commit sau khi push', 'PUSH_UNVERIFIED');
  }
  return { pushed: true, branch: versionBranch, sha: target };
}

async function ensurePr({ dzHome, project, versionBranch, title, body, live, record, gh = runGh }) {
  const { tmp } = pathsFor({ dzHome, project });
  const head = check(VERSION_BRANCH, versionBranch, 'nhánh version');
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
    if (open) return { number: open.number, url: open.url, created: false };
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, redact(body), { mode: 0o600 });
    const { stdout } = await gh(['pr', 'create', ...common, '--draft', `--title=${redact(title)}`, '--body-file', bodyFile], { cwd: dir });
    const url = stdout.match(/https:\/\/\S+\/pull\/(\d+)/);
    if (url) return { number: Number(url[1]), url: url[0], created: true };
    const made = await find();
    if (!made) throw new GitError('gh không trả về PR vừa tạo', 'PR_UNVERIFIED');
    return { number: made.number, url: made.url, created: true };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function commentPr({ dzHome, project, number, body, live, record, gh = runGh }) {
  if (!Number.isInteger(number) || number < 1) throw new GitError('số PR không hợp lệ', 'INVALID');
  githubUrlOf(project);
  if (live !== true) {
    record('would', `gh pr comment ${number} (${project.repo})`);
    return { dryRun: true };
  }
  const { tmp } = pathsFor({ dzHome, project });
  const dir = await makeTmp(tmp);
  try {
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, redact(body.startsWith('[Claude]') ? body : `[Claude] ${body}`), { mode: 0o600 });
    await gh(['pr', 'comment', String(number), '--repo', project.repo, '--body-file', bodyFile], { cwd: dir });
    return { posted: true };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { makeTmp, pushVersion, ensurePr, commentPr };
