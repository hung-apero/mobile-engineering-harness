const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('../redact.cjs');

const LOCAL_TIMEOUT_MS = 5 * 60 * 1000;
const REMOTE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BUFFER = 256 * 1024 * 1024;

const KEY = /^[A-Z][A-Z0-9]+$/;
const REPO = /^\w[\w.-]*\/\w[\w.-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const LANE = /^fix\/[a-z0-9][a-z0-9-]{0,80}$/;
const VERSION_BRANCH = /^dz\/release-[0-9][0-9A-Za-z.-]*$/;
const BASE = /^[A-Za-z0-9][\w.-]*(?:\/[\w][\w.-]*)*$/;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BAD_REF = /\.\.|\.lock(?:\/|$)|\.$/;
const ZERO = '0'.repeat(40);

const SAFE_CONFIG = {
  'core.hooksPath': '/dev/null',
  'core.fsmonitor': 'false',
  'commit.gpgSign': 'false',
  'tag.gpgSign': 'false',
  'push.gpgSign': 'false',
  'push.followTags': 'false',
  'fetch.prune': 'false',
  'fetch.pruneTags': 'false',
  'submodule.recurse': 'false',
};

const LOCAL_CONFIG = {
  'user.name': 'dev-zone',
  'user.email': 'dev-zone@localhost',
  'core.attributesFile': '/dev/null',
  'core.excludesFile': '/dev/null',
  'rerere.enabled': 'false',
  'credential.helper': '',
};

class GitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

const cleanUrl = text => String(text).replace(/:\/\/[^/@\s]+@/g, '://');

function cleanEnv(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_') || name.startsWith('GIT_SSH')) env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extra };
}

function execTool(bin, args, { cwd, env, timeoutMs, okCodes = [0] }) {
  return new Promise((resolve, reject) => {
    const options = { cwd, env, timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: MAX_BUFFER, encoding: 'utf8' };
    const child = execFile(bin, args, options, (error, stdout, stderr) => {
      const code = error ? error.code : 0;
      if (typeof code === 'number' && okCodes.includes(code)) return resolve({ code, stdout, stderr });
      const reason = error.killed ? `quá ${timeoutMs} ms hoặc quá nhiều dữ liệu` : `mã ${error.code ?? error.signal}`;
      const detail = redact(cleanUrl(stderr).trim()).slice(0, 500);
      reject(new GitError(`${path.basename(bin)} ${args.find(a => /^[a-z]/.test(a) && !a.includes('=')) ?? ''}: ${reason}${detail ? `: ${detail}` : ''}`, error.code ?? error.signal));
    });
    child.stdin.end();
  });
}

function runGit(args, { remote = false, cwd, gitDir, timeoutMs, okCodes } = {}) {
  const config = remote ? SAFE_CONFIG : { ...SAFE_CONFIG, ...LOCAL_CONFIG };
  const flags = Object.entries(config).flatMap(([name, value]) => ['-c', `${name}=${value}`]);
  const env = cleanEnv(remote ? {} : { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  return execTool('git', [...(gitDir ? [`--git-dir=${gitDir}`] : []), ...flags, ...args], {
    cwd, env, okCodes, timeoutMs: timeoutMs ?? (remote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS),
  });
}

function runGh(args, { cwd, timeoutMs = 2 * 60 * 1000 } = {}) {
  return execTool('gh', args, { cwd, timeoutMs, env: cleanEnv({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }) });
}

function check(pattern, value, label) {
  const text = String(value ?? '');
  if (!pattern.test(text) || BAD_REF.test(text)) throw new GitError(`${label} không hợp lệ: ${redact(text).slice(0, 100)}`, 'INVALID');
  return text;
}

function pathsFor({ dzHome, project }) {
  if (typeof dzHome !== 'string' || !path.isAbsolute(dzHome)) throw new GitError('dzHome phải là đường dẫn tuyệt đối', 'INVALID');
  const root = path.join(fs.realpathSync(dzHome), 'workspaces', check(KEY, project.key, 'key'));
  return { root, mirror: path.join(root, 'mirror.git'), tmp: path.join(root, 'tmp'), batches: path.join(root, 'batches') };
}

const githubUrlOf = (project, override) => override ?? `https://github.com/${check(REPO, project.repo, 'repo')}.git`;

function checkBase(base) {
  check(BASE, base, 'nhánh gốc');
  if (/^(?:dz|fix)\//.test(base)) throw new GitError('nhánh gốc không được nằm trong dz/ hoặc fix/', 'INVALID');
  return base;
}

async function refSha(git, gitDir, ref, cwd) {
  const out = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { gitDir, cwd, okCodes: [0, 1] });
  return out.code === 0 && SHA.test(out.stdout.trim()) ? out.stdout.trim() : null;
}

async function isAncestor(git, gitDir, older, newer) {
  return (await git(['merge-base', '--is-ancestor', older, newer], { gitDir, okCodes: [0, 1] })).code === 0;
}

async function requireRef(git, mirror, branch) {
  const sha = await refSha(git, mirror, `refs/heads/${branch}`);
  if (!sha) throw new GitError(`mirror không có nhánh ${branch}`, 'NO_REF');
  return sha;
}

async function remoteSha(git, gitDir, url, branch) {
  const ref = `refs/heads/${branch}`;
  const { stdout } = await git(['ls-remote', '--refs', '--', url, ref], { gitDir, remote: true });
  const line = stdout.split('\n').find(row => row.split('\t')[1] === ref);
  return line ? line.split('\t')[0] : null;
}

module.exports = {
  GitError, runGit, runGh, check, checkBase, pathsFor, githubUrlOf, refSha, isAncestor, remoteSha, requireRef,
  SHA, LANE, VERSION_BRANCH, BATCH_ID, ZERO,
};
