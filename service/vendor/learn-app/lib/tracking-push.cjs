const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeJsonAtomic } = require('./learn-app-state.cjs');
const { trackingDir, readJson, SCHEMA } = require('./tracking.cjs');
const { validate } = require('./json-schema-lite.cjs');

const DEFAULT_REMOTE = 'https://github.com/hung-apero/learn-app-memory.git';
const SCHEMA_DIR = path.join(__dirname, '..', 'tracking-schema');
const MARKER = '.learn-app-cache';
const LOCK_STALE_MS = 5 * 60 * 1000;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' };
const GIT_SAFE = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function redact(text) {
  return String(text).replace(/(\/\/)[^/@\s]+@/g, '$1***@');
}

function git(cwd, args) {
  const run = spawnSync('git', [...GIT_SAFE, ...args], { cwd, encoding: 'utf8', timeout: 30 * 1000, env: { ...process.env, ...GIT_ENV } });
  if (run.error) throw new Error(run.error.code === 'ETIMEDOUT' ? 'git quá thời gian (mạng chậm hoặc đang chờ đăng nhập)' : run.error.message);
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'git lỗi').trim().split('\n').pop());
  return run.stdout.trim();
}

function cacheDir() {
  return path.resolve(process.env.LEARN_APP_MEMORY_CACHE || path.join(os.homedir(), '.cache', 'learn-app', 'memory'));
}

function freshClone(remote, dir) {
  if (fs.existsSync(dir)) {
    const marker = path.join(dir, '.git', MARKER);
    if (!fs.existsSync(marker)) throw new Error(`${dir} đã có sẵn và không phải bản sao do learn-app tạo — không đụng vào; chọn LEARN_APP_MEMORY_CACHE khác`);
    if (fs.readFileSync(marker, 'utf8').trim() !== remote) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(path.dirname(dir), ['clone', '-q', remote, dir]);
    fs.writeFileSync(path.join(dir, '.git', MARKER), remote);
    return;
  }
  git(dir, ['fetch', '-q', 'origin']);
  git(dir, ['reset', '-q', '--hard', 'origin/main']);
  git(dir, ['clean', '-qfd']);
}

function indexEntry(snapshot) {
  return {
    app: snapshot.app,
    status: snapshot.status,
    step: snapshot.step,
    updatedAt: snapshot.updatedAt,
    plansReviewed: snapshot.plans.filter(p => p.status === 'reviewed').length,
    plansTotal: snapshot.plans.length,
    features: snapshot.features.map(f => f.id),
    pr: snapshot.pr,
    bugsOpen: snapshot.bugs.open,
  };
}

function readIndexEntries(dir) {
  return fs.readdirSync(path.join(dir, 'apps')).flatMap(name => {
    try {
      const snapshot = readJson(path.join(dir, 'apps', name, 'app.json'), null);
      return snapshot && typeof snapshot.updatedAt === 'string' ? [indexEntry(snapshot)] : [];
    } catch {
      return [];
    }
  });
}

function mergeEvents(existing, local) {
  const key = e => `${e.at}|${e.command}|${e.step}`;
  const seen = new Map([...((existing && existing.events) || []), ...local.events].map(e => [key(e), e]));
  return { ...local, events: [...seen.values()].sort((a, b) => a.at.localeCompare(b.at)) };
}

function bugCounts(dir, app) {
  const bugsDir = path.join(dir, 'apps', app, 'bugs');
  if (!fs.existsSync(bugsDir)) return { open: 0, fixed: 0 };
  const statuses = fs.readdirSync(bugsDir).filter(name => name.endsWith('.json') && !name.startsWith('_')).map(name => (readJson(path.join(bugsDir, name), {}) || {}).status);
  return { open: statuses.filter(s => s === 'open').length, fixed: statuses.filter(s => s === 'fixed').length };
}

function rebuildIndex(dir) {
  writeJsonAtomic(path.join(dir, 'index.json'), { schema: SCHEMA, generatedAt: new Date().toISOString(), apps: readIndexEntries(dir).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
}

function writeInto(dir, snapshot, run) {
  snapshot = { ...snapshot, bugs: bugCounts(dir, snapshot.app) };
  const appDir = path.join(dir, 'apps', snapshot.app);
  fs.mkdirSync(path.join(appDir, 'runs'), { recursive: true });
  const current = readJson(path.join(appDir, 'app.json'), null);
  if (!current || !(typeof current.updatedAt === 'string' && current.updatedAt > snapshot.updatedAt)) writeJsonAtomic(path.join(appDir, 'app.json'), snapshot);
  const runFile = path.join(appDir, 'runs', `${snapshot.runId}.json`);
  writeJsonAtomic(runFile, mergeEvents(readJson(runFile, null), run));
  fs.mkdirSync(path.join(dir, 'schema'), { recursive: true });
  for (const name of fs.readdirSync(SCHEMA_DIR)) fs.copyFileSync(path.join(SCHEMA_DIR, name), path.join(dir, 'schema', name));
  rebuildIndex(dir);
}

function contractErrors(snapshot, run) {
  const schema = name => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
  return [...validate(schema('app.schema.json'), snapshot), ...validate(schema('run.schema.json'), run)];
}

function takeLock(dir) {
  const lock = `${dir}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
  } catch {}
  try {
    fs.mkdirSync(lock);
    return () => fs.rmSync(lock, { recursive: true, force: true });
  } catch {
    return null;
  }
}

function pushTracking(root) {
  if (process.env.LEARN_APP_TRACKING === 'off') return { pushed: false, reason: 'off' };
  const dir = trackingDir(root);
  const pendingFile = path.join(dir, 'pending');
  if (!fs.existsSync(pendingFile)) return { pushed: false, reason: 'nothing' };
  const pendingMark = fs.readFileSync(pendingFile, 'utf8');
  const snapshot = readJson(path.join(dir, 'app.json'), null);
  const run = readJson(path.join(dir, 'run.json'), null);
  if (!snapshot || !run) return { pushed: false, reason: 'chưa có dữ liệu tracking' };
  const errors = contractErrors(snapshot, run);
  if (errors.length) return { pushed: false, schema: true, reason: `dữ liệu sai schema: ${errors.slice(0, 3).join('; ')}` };
  const remote = process.env.LEARN_APP_MEMORY_REMOTE || DEFAULT_REMOTE;
  const clone = cacheDir();
  const release = takeLock(clone);
  if (!release) return { pushed: false, reason: 'đang có lần đẩy khác trên máy này — sẽ đẩy lại ở mốc sau' };
  try {
    for (let attempt = 1; ; attempt += 1) {
      freshClone(remote, clone);
      writeInto(clone, snapshot, run);
      git(clone, ['add', '-A']);
      if (!git(clone, ['status', '--porcelain'])) break;
      git(clone, ['-c', 'user.name=learn-app', '-c', 'user.email=learn-app@users.noreply.github.com', 'commit', '-q', '-m', `track(${snapshot.app}): ${snapshot.step}${snapshot.currentPlan ? ` · ${snapshot.currentPlan}` : ''}`]);
      try {
        git(clone, ['push', '-q', 'origin', 'HEAD:main']);
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
    if (fs.existsSync(pendingFile) && fs.readFileSync(pendingFile, 'utf8') === pendingMark) fs.unlinkSync(pendingFile);
    return { pushed: true };
  } catch (error) {
    return { pushed: false, reason: `${redact(error.message)} — sẽ đẩy lại ở mốc sau (cần quyền ghi ${redact(remote).replace(/\.git$/, '')}; thử gh auth setup-git)` };
  } finally {
    release();
  }
}

module.exports = { pushTracking, DEFAULT_REMOTE, redact, git, freshClone, takeLock, cacheDir, bugCounts, rebuildIndex, SCHEMA_DIR };
