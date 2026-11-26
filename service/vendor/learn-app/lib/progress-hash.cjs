const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DIR } = require('./learn-app-state.cjs');

// Machine-local files the harness writes on its own; kept out of git so they never look like progress.
const LOCAL_FILES = ['autopilot.json', 'rc-applied.json', 'store-version.json', 'notified.json'];

function readOr(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function ensureIgnored(root) {
  const file = path.join(root, DIR, '.gitignore');
  const text = readOr(file);
  const lines = text.split(/\r?\n/);
  const missing = LOCAL_FILES.filter(name => !lines.includes(name));
  if (missing.length) fs.appendFileSync(file, `${text && !/\n$/.test(text) ? '\n' : ''}${missing.join('\n')}\n`);
}

// Content, not just status letters: editing an already-modified file again still counts as progress.
// exclude: folders under root left out, e.g. the harness folder when only app code matters. With it the snapshot
// covers the whole repository (a monorepo app builds modules outside its folder), not only root.
function gitSnapshot(root, { exclude = [] } = {}) {
  try {
    const run = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    const prefix = exclude.length ? run(['rev-parse', '--show-prefix']).trim() : '';
    const spec = exclude.length ? ['--', ':/', ...exclude.map(dir => `:(top,exclude)${prefix}${dir}`)] : [];
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z', ...spec]).split('\0').filter(Boolean).map(rel => {
      try {
        const stat = fs.statSync(path.join(root, rel));
        return `${rel}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return rel;
      }
    });
    return [run(['rev-parse', 'HEAD']), run(['diff', 'HEAD', ...spec]), ...untracked].join('\n');
  } catch {
    return '';
  }
}

function worktreeDirs(root) {
  const dir = path.join(root, DIR, 'wt');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map(name => path.join(dir, name)) : [];
}

// Progress fingerprint: state and the working trees (code an agent wrote, in the
// main root or in a plan's worktree).
function progressHash(root) {
  const hash = crypto.createHash('sha256')
    .update(readOr(path.join(root, DIR, 'state.json')))
    .update(gitSnapshot(root));
  for (const dir of worktreeDirs(root)) hash.update(dir).update(gitSnapshot(dir));
  return hash.digest('hex');
}

function newestMtime(files) {
  return Math.max(0, ...files.map(file => {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  }));
}

// Last time a plan's chain did something: a file changed or committed in its worktree, or its agent report
// or UI screenshots were written.
function planActivity(root, plan, worktree) {
  const files = [
    ...fs.existsSync(path.join(root, DIR, 'reports', 'agents')) ? fs.readdirSync(path.join(root, DIR, 'reports', 'agents')).filter(n => n.endsWith(`-${plan}.md`)).map(n => path.join(root, DIR, 'reports', 'agents', n)) : [],
  ];
  let committed = 0;
  if (worktree) {
    const dir = path.join(root, worktree);
    try {
      const run = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      committed = Number(run(['log', '-1', '--format=%ct']).trim()) * 1000 || 0;
      files.push(...run(['status', '--porcelain', '-z', '--no-renames']).split('\0').filter(Boolean).map(e => path.join(dir, e.slice(3))));
    } catch {}
  }
  return Math.max(committed, newestMtime(files));
}

module.exports = { gitSnapshot, LOCAL_FILES, ensureIgnored, progressHash, readOr, planActivity };
