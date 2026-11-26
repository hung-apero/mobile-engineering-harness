const fs = require('node:fs');
const path = require('node:path');
const {
  GitError, runGit, check, checkBase, pathsFor, githubUrlOf, refSha, remoteSha, SHA, VERSION_BRANCH, BATCH_ID, ZERO,
} = require('./git.cjs');

const AGENTS = ['bug-fixer', 'bug-reviewer', 'bug-scout', 'ui-board-judge'];
const FEATURE_AGENTS = ['architect', 'coder', 'qa', 'reviewer'];
const FEATURE_FILES = [
  'skills/feature/scripts/headless_check.py', 'skills/spec-clear/SKILL.md', 'overlay.schema.yaml',
  'skills/harness-init/scripts/detect-stack.sh', 'skills/harness-init/scripts/render-overlay.sh', 'skills/harness-init/scripts/validate-overlay.py',
];
const COMMIT = /^[0-9a-f]{7,40}$/;
const DARWIN_CONFIG = process.platform === 'darwin' ? '\tignorecase = true\n\tprecomposeunicode = true\n' : '';
const MIRROR_CONFIG = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n${DARWIN_CONFIG}[receive]\n\tdenyDeletes = true\n\tdenyNonFastForwards = true\n`;
const UPDATE_HOOK = '#!/bin/sh\ncase "$1" in\n  refs/heads/fix/*) exit 0 ;;\nesac\necho "mirror chi nhan nhanh fix/*" >&2\nexit 1\n';

const lstat = target => fs.lstatSync(target, { throwIfNoEntry: false });
const versionBranch = (version, branch = `dz/release-${version}`) => check(VERSION_BRANCH, branch, 'nhánh version');

function writeIfChanged(file, text, mode) {
  if (lstat(file)?.isFile() && fs.readFileSync(file, 'utf8') === text) return;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode });
  fs.renameSync(temp, file);
}

async function ensureMirror({ dzHome, project, githubUrl, git = runGit }) {
  const { root, mirror } = pathsFor({ dzHome, project });
  const base = checkBase(project.base);
  const url = githubUrlOf(project, githubUrl);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstat(path.join(mirror, 'HEAD'))) await git(['init', '--quiet', '--bare', '--template=', '--', mirror], { cwd: root });
  fs.mkdirSync(path.join(mirror, 'hooks'), { recursive: true });
  writeIfChanged(path.join(mirror, 'config'), MIRROR_CONFIG, 0o644);
  writeIfChanged(path.join(mirror, 'hooks', 'update'), UPDATE_HOOK, 0o755);
  const ref = `refs/heads/${base}`;
  await git(['symbolic-ref', 'HEAD', ref], { gitDir: mirror });
  await git(['fetch', '--quiet', '--no-tags', '--no-prune', '--no-write-fetch-head', '--no-recurse-submodules', '--', url, `+${ref}:${ref}`], { gitDir: mirror, remote: true });
  return { mirror, baseSha: await refSha(git, mirror, ref) };
}

async function ensureVersionBranch({ dzHome, project, version, branch: name, githubUrl, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const branch = versionBranch(version, name);
  const ref = `refs/heads/${branch}`;
  const existing = await refSha(git, mirror, ref);
  if (existing) return { branch, sha: existing, created: false };
  const url = githubUrlOf(project, githubUrl);
  if (await remoteSha(git, mirror, url, branch)) {
    await git(['fetch', '--quiet', '--no-tags', '--no-prune', '--no-write-fetch-head', '--no-recurse-submodules', '--', url, `${ref}:${ref}`], { gitDir: mirror, remote: true });
    return { branch, sha: await refSha(git, mirror, ref), created: true };
  }
  const sha = await refSha(git, mirror, `refs/heads/${checkBase(project.base)}`);
  if (!sha) throw new GitError('mirror chưa có nhánh gốc', 'NO_REF');
  await git(['update-ref', '-m', 'dev-zone', ref, sha, ZERO], { gitDir: mirror });
  return { branch, sha, created: true };
}

function realDir(dir) {
  const stat = lstat(dir);
  if (!stat) fs.mkdirSync(dir);
  else if (!stat.isDirectory()) throw new GitError(`${dir} phải là thư mục thật`, 'UNSAFE_PATH');
  return dir;
}

function realDirChain(root, relative) {
  return relative.split('/').filter(part => part && part !== '.').reduce((dir, part) => realDir(path.join(dir, part)), root);
}

function excludeLines(repo, lines) {
  const file = path.join(realDirChain(repo, '.git/info'), 'exclude');
  const text = lstat(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = lines.filter(line => !text.split('\n').includes(line));
  if (missing.length) writeIfChanged(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, 0o644);
}

async function copyLocalFiles({ project, repo, git }) {
  const files = project.localFiles ?? [];
  if (files.length === 0) return;
  const source = fs.realpathSync(project.checkout);
  for (const name of files) {
    const bad = reason => new GitError(`localFiles ${name}: ${reason}`, 'LOCAL_FILE');
    const parts = String(name).split('/');
    if (path.isAbsolute(name) || /[\\\n*?[\]!#]/.test(name) || parts.some(p => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw bad('đường dẫn không hợp lệ');
    const from = path.join(source, name);
    if (!lstat(from)?.isFile() || fs.realpathSync(from) !== from) throw bad('phải là file thường nằm trong checkout');
    const tracked = await git(['ls-files', '--', `:(literal)${name}`], { cwd: repo });
    if (tracked.stdout) throw bad('đang được git theo dõi');
    const to = path.join(realDirChain(repo, path.dirname(name)), path.basename(name));
    excludeLines(repo, [`/${name}`]);
    if (!lstat(to)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else if (!lstat(to).isFile()) throw bad('đích không phải file thường');
  }
}

async function checkHarness({ dzHome, project, git }) {
  const harness = path.join(fs.realpathSync(dzHome), 'harness');
  const pin = check(COMMIT, project.harnessCommit, 'harnessCommit');
  if (!lstat(path.join(harness, '.git'))) throw new GitError('thiếu $DZ_HOME/harness', 'HARNESS');
  const head = await refSha(git, undefined, 'HEAD', harness);
  if (!head?.startsWith(pin)) throw new GitError(`harness ở ${head}, cấu hình ghim ${pin}`, 'HARNESS');
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'], { cwd: harness });
  if (dirty.stdout) throw new GitError('harness có file bị sửa so với commit đã ghim', 'HARNESS');
  const skills = await git(['ls-tree', '-d', '-z', '--name-only', 'HEAD:skills'], { cwd: harness });
  return { harness, skills: skills.stdout.split('\0').filter(Boolean) };
}

async function linkHarness({ dzHome, project, repo, git, agents = AGENTS, files = [] }) {
  const { harness, skills } = await checkHarness({ dzHome, project, git });
  const lost = files.filter(file => !lstat(path.join(harness, file))?.isFile());
  if (lost.length) throw new GitError(`harness ghim thiếu ${lost.join(', ')}`, 'HARNESS');
  excludeLines(repo, ['.claude/']);
  const skillDir = realDirChain(repo, '.claude/skills');
  const agentDir = realDirChain(repo, '.claude/agents');
  for (const name of skills) {
    const link = path.join(skillDir, name);
    const target = path.join(harness, 'skills', name);
    const stat = lstat(link);
    if (stat && !stat.isSymbolicLink()) throw new GitError(`.claude/skills/${name} đã có trong repo`, 'HARNESS');
    if (stat && fs.readlinkSync(link) === target) continue;
    if (stat) fs.unlinkSync(link);
    fs.symlinkSync(target, link);
  }
  for (const name of agents) {
    const from = path.join(harness, 'agents', `${name}.md`);
    if (!lstat(from)?.isFile()) throw new GitError(`harness thiếu agent ${name}`, 'HARNESS');
    writeIfChanged(path.join(agentDir, `${name}.md`), fs.readFileSync(from, 'utf8'), 0o644);
  }
}

function linkOverlay({ dzHome, project, repo, tracked = false }) {
  const home = fs.realpathSync(dzHome);
  excludeLines(repo, ['.harness-overlay/']);
  const dir = realDirChain(repo, '.harness-overlay');
  if (tracked) {
    if (!lstat(path.join(dir, 'overlay.yaml'))?.isFile()) throw new GitError('.harness-overlay/overlay.yaml của repo app không phải file thường', 'OVERLAY');
  } else {
    const source = path.join(home, 'projects', `${project.key}.overlay.yaml`);
    if (!lstat(source)?.isFile()) throw new GitError(`thiếu overlay của project: ${source}`, 'OVERLAY');
    writeIfChanged(path.join(dir, 'overlay.yaml'), fs.readFileSync(source, 'utf8'), 0o644);
  }
  const link = path.join(dir, 'upstream');
  const target = path.join(home, 'harness');
  const stat = lstat(link);
  if (stat && !stat.isSymbolicLink()) throw new GitError('.harness-overlay/upstream đã có trong repo', 'OVERLAY');
  if (stat && fs.readlinkSync(link) === target) return;
  if (stat) fs.unlinkSync(link);
  fs.symlinkSync(target, link);
}

async function ensureClone({ dzHome, project, batch, sha, git = runGit }) {
  const { mirror, batches } = pathsFor({ dzHome, project });
  const dir = path.join(batches, check(BATCH_ID, batch.id, 'batch.id'));
  const repo = path.join(dir, 'repo');
  const startFile = path.join(dir, 'start-sha');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstat(repo)) {
    const branch = versionBranch(batch.version, batch.branch);
    const partial = path.join(dir, 'repo.partial');
    await fs.promises.rm(partial, { recursive: true, force: true });
    await git(['clone', '--quiet', '--no-tags', '--template=', '--branch', branch, '--', mirror, partial], { cwd: dir });
    if (sha) {
      await git(['update-ref', `refs/remotes/origin/${branch}`, check(SHA, sha, 'sha')], { cwd: partial });
      await git(['reset', '--quiet', '--hard', sha], { cwd: partial });
    }
    for (const [name, value] of [['user.name', 'dev-zone'], ['user.email', 'dev-zone@localhost']]) await git(['config', '--local', name, value], { cwd: partial });
    writeIfChanged(startFile, `${await refSha(git, undefined, 'HEAD', partial)}\n`, 0o600);
    fs.renameSync(partial, repo);
  }
  const origin = await git(['config', '--local', '--get', 'remote.origin.url'], { cwd: repo, okCodes: [0, 1] });
  if (origin.stdout.trim() !== mirror) throw new GitError('origin của bản clone không phải mirror', 'ORIGIN');
  await copyLocalFiles({ project, repo, git });
  await linkHarness({ dzHome, project, repo, git });
  return { repo, startSha: fs.readFileSync(startFile, 'utf8').trim() };
}

module.exports = { versionBranch, ensureMirror, ensureVersionBranch, ensureClone, linkHarness, linkOverlay, excludeLines, FEATURE_AGENTS, FEATURE_FILES };
