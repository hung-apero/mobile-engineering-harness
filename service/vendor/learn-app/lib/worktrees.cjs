const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { git, gitSucceeds, firstLine } = require('./cli-io.cjs');
const { isSecretPath } = require('./secret-files.cjs');

const SKIP_DIRS = new Set(['build', '.gradle', '.git', '.learn-app', 'node_modules', '.idea']);
const MAX_DEPTH = 5;
const PLAN_BRANCH = /^learn-app\/.+-plan-.+$/;

function worktreeRel(plan) {
  return ['.learn-app', 'wt', plan].join('/');
}

function worktreeDir(root, plan) {
  return path.join(root, '.learn-app', 'wt', plan);
}

function normalizePath(p) {
  let full = path.resolve(p);
  try {
    full = fs.realpathSync.native(full);
  } catch {}
  return full.replace(/\\/g, '/').toLowerCase();
}

// { dir → branch } of every worktree git knows about.
function registered(root) {
  const out = {};
  let dir = null;
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) dir = normalizePath(line.slice('worktree '.length));
    if (line.startsWith('branch ') && dir) out[dir] = line.slice('branch refs/heads/'.length);
  }
  return out;
}

function listSecretCandidatesRaw(dir, depth = 0, out = []) {
  if (depth > MAX_DEPTH || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listSecretCandidatesRaw(full, depth + 1, out);
    } else if (isSecretPath(entry.name) || entry.name === 'google-services.json') {
      out.push(full);
    }
  }
  return out;
}

// Cache by the mtime of the root's direct children: a new/removed secret touches that mtime, so a
// stale cache is impossible without the root changing. Keeps 3 worktree creates in one session from
// doing a depth-5 walk three times.
const secretCache = new Map();

function listSecretCandidates(dir, depth = 0, out) {
  if (depth !== 0 || out) return listSecretCandidatesRaw(dir, depth, out);
  let rootMtime;
  try {
    rootMtime = fs.statSync(dir).mtimeMs;
  } catch {
    return [];
  }
  const key = `${dir}:${rootMtime}`;
  const cached = secretCache.get(key);
  if (cached) return cached.slice();
  const list = listSecretCandidatesRaw(dir, 0, []);
  secretCache.set(key, list);
  return list.slice();
}

// Copies build secrets git ignores into the worktree, never reading them. A secret that is not ignored is left
// out, so no commit in the worktree can pick it up.
function copySecrets(root, dir) {
  for (const abs of listSecretCandidates(root)) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (!gitSucceeds(root, ['check-ignore', '-q', rel])) continue;
    const dest = path.join(dir, rel);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
}

function create(root, { plan, branch, integration }) {
  const dir = worktreeDir(root, plan);
  const current = registered(root)[normalizePath(dir)];
  if (current !== undefined && current !== branch) throw new Error(`Worktree ${worktreeRel(plan)} còn của branch ${current} — xoá nó trước (worktree cũ chưa dọn được)`);
  if (current === undefined) {
    if (fs.existsSync(dir)) throw new Error(`Thư mục ${worktreeRel(plan)} còn sót từ lần trước — xoá thư mục đó rồi chạy lại`);
    git(root, ['worktree', 'add', '-b', branch, dir, integration]);
  }
  copySecrets(root, dir);
  return { dir, rel: worktreeRel(plan), branch, base: git(dir, ['rev-parse', 'HEAD']) };
}

// Gradle and Kotlin daemons keep files under build/ open, which blocks removal on Windows.
function stopDaemons(dir) {
  if (fs.existsSync(path.join(dir, 'gradlew'))) spawnSync('./gradlew', ['--stop'], { cwd: dir, stdio: 'ignore', timeout: 60000, shell: process.platform === 'win32' });
}

function remove(root, plan, branch) {
  const dir = worktreeDir(root, plan);
  const errors = [];
  if (registered(root)[normalizePath(dir)] !== undefined) {
    stopDaemons(dir);
    try {
      git(root, ['worktree', 'remove', '--force', dir]);
    } catch (error) {
      errors.push(firstLine(error));
    }
  }
  gitSucceeds(root, ['worktree', 'prune']);
  // Only a plan branch is ever deleted, never the integration branch.
  if (branch && PLAN_BRANCH.test(branch) && gitSucceeds(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])) {
    try {
      git(root, ['branch', '-D', branch]);
    } catch (error) {
      errors.push(firstLine(error));
    }
  }
  return { ok: !errors.length, error: errors.join('; ') || null };
}

function stagedSecrets(dir) {
  return git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean).filter(isSecretPath);
}

// Commits everything outside .learn-app; refuses (and unstages) when a secret would go in.
function commitAll(dir, message) {
  git(dir, ['add', '-A', '--', '.', ':(exclude).learn-app']);
  const secrets = stagedSecrets(dir);
  if (secrets.length) {
    git(dir, ['reset', '-q']);
    throw new Error(`Không commit được vì có file bí mật chưa được gitignore: ${secrets.join(', ')}`);
  }
  if (!git(dir, ['diff', '--cached', '--name-only'])) return null;
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function nulList(dir, args) {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${run.stderr || ''}`.trim().split('\n')[0] || `git ${args[0]} lỗi`);
  return run.stdout.split('\0').filter(Boolean);
}

// Files the branch changed since it left `since` (three dots: changes pulled in from `since` do not count),
// plus anything not committed yet.
function changedFiles(dir, since) {
  const committed = nulList(dir, ['diff', '--name-only', '-z', `${since}...HEAD`]);
  const pending = nulList(dir, ['status', '--porcelain', '-z', '--no-renames']).map(entry => entry.slice(3));
  return [...new Set([...committed, ...pending].map(p => p.split(path.sep).join('/')))].sort();
}

function mergeInProgress(dir) {
  return gitSucceeds(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
}

function syncIntegration(dir, integration) {
  try {
    git(dir, ['merge', '--no-edit', integration]);
    return { ok: true };
  } catch (error) {
    if (mergeInProgress(dir)) return { ok: false, conflict: git(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean) };
    throw new Error(firstLine(error));
  }
}

function isAncestor(root, ancestor, of = 'HEAD') {
  return gitSucceeds(root, ['merge-base', '--is-ancestor', ancestor, of]);
}

function mergeIntoRoot(root, branch, message) {
  try {
    git(root, ['merge', '--no-ff', '-m', message, branch]);
    return git(root, ['rev-parse', 'HEAD']);
  } catch (error) {
    if (mergeInProgress(root)) gitSucceeds(root, ['merge', '--abort']);
    throw new Error(firstLine(error));
  }
}

module.exports = { worktreeRel, create, remove, commitAll, changedFiles, syncIntegration, mergeInProgress, mergeIntoRoot, isAncestor, stagedSecrets };
