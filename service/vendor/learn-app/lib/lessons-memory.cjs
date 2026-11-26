const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { DIR, writeJsonAtomic } = require('./learn-app-state.cjs');
const { readJson } = require('./tracking.cjs');
const { validate } = require('./json-schema-lite.cjs');
const T = require('./tracking-push.cjs');
const { readOut, jsonFiles, schema, LESSON_ID } = require('./lessons-validate.cjs');

const FIRST_LOOKBACK_DAYS = 90;
const MEMORY_REPO = 'hung-apero/learn-app-memory';

function withMemory(fn) {
  const remote = process.env.LEARN_APP_MEMORY_REMOTE || T.DEFAULT_REMOTE;
  const clone = T.cacheDir();
  const release = T.takeLock(clone);
  if (!release) throw new Error('đang có lần đẩy khác trên máy này — thử lại sau ít phút');
  try {
    T.freshClone(remote, clone);
    return fn(clone);
  } finally {
    release();
  }
}

function pendingLessons(clone) {
  const refs = T.git(clone, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/lessons']).split('\n').filter(Boolean);
  const merged = new Set(jsonFiles(path.join(clone, 'lessons')));
  const found = new Map();
  for (const ref of refs) {
    for (const file of T.git(clone, ['ls-tree', '--name-only', ref, 'lessons/']).split('\n').filter(Boolean)) {
      const name = path.basename(file);
      if (!name.endsWith('.json') || name.startsWith('_') || merged.has(name)) continue;
      try {
        found.set(name, JSON.parse(T.git(clone, ['show', `${ref}:${file}`])));
      } catch {}
    }
  }
  return [...found.values()].filter(l => l && LESSON_ID.test(l.id || ''));
}

function knownLessons(clone) {
  const merged = jsonFiles(path.join(clone, 'lessons')).map(n => readJson(path.join(clone, 'lessons', n), null)).filter(Boolean);
  return { merged, pending: pendingLessons(clone) };
}

function prepare(app) {
  return withMemory(clone => {
    const cursor = readJson(path.join(clone, 'apps', app, 'bugs', '_cursor.json'), null);
    const since = cursor && cursor.since ? cursor.since : new Date(Date.now() - FIRST_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), `learn-app-lessons-${app}-`));
    const { merged, pending } = knownLessons(clone);
    for (const [sub, list] of [['lessons', merged], ['pending-lessons', pending]]) {
      fs.mkdirSync(path.join(snapshot, sub), { recursive: true });
      for (const lesson of list) writeJsonAtomic(path.join(snapshot, sub, `${lesson.id}.json`), lesson);
    }
    fs.mkdirSync(path.join(snapshot, 'schema'), { recursive: true });
    for (const name of fs.readdirSync(T.SCHEMA_DIR)) fs.copyFileSync(path.join(T.SCHEMA_DIR, name), path.join(snapshot, 'schema', name));
    return { app, memory: snapshot, since, lessons: merged.length, pendingLessons: pending.length, firstRun: !cursor };
  });
}

function commitAndPush(clone, message, ref) {
  T.git(clone, ['add', '-A']);
  if (!T.git(clone, ['status', '--porcelain'])) return false;
  T.git(clone, ['-c', 'user.name=learn-app', '-c', 'user.email=learn-app@users.noreply.github.com', 'commit', '-q', '-m', message]);
  T.git(clone, ['push', '-q', 'origin', ref]);
  return true;
}

function onMain(clone, message, write) {
  for (let attempt = 1; ; attempt += 1) {
    T.git(clone, ['fetch', '-q', 'origin']);
    T.git(clone, ['checkout', '-q', '-B', 'main', 'origin/main']);
    const result = write();
    try {
      commitAndPush(clone, message, 'HEAD:main');
      return result;
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
}

function reserveIds(clone, drafts) {
  if (!drafts.length) return {};
  return onMain(clone, `lessons: giữ chỗ ${drafts.length} id`, () => {
    const { merged, pending } = knownLessons(clone);
    const counter = readJson(path.join(clone, 'lessons', '_next.json'), { next: 1 });
    let next = Math.max(counter.next || 1, ...[...merged, ...pending].map(l => Number(l.id.slice(2)) + 1));
    const renamed = {};
    for (const draft of drafts) renamed[draft] = `L-${String(next++).padStart(3, '0')}`;
    fs.mkdirSync(path.join(clone, 'lessons'), { recursive: true });
    writeJsonAtomic(path.join(clone, 'lessons', '_next.json'), { next });
    return renamed;
  });
}

function openLessonsPr(clone, app, lessons) {
  const branch = `lessons/${app.toLowerCase()}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${crypto.randomBytes(2).toString('hex')}`;
  T.git(clone, ['checkout', '-q', '-B', branch, 'origin/main']);
  for (const lesson of lessons) writeJsonAtomic(path.join(clone, 'lessons', `${lesson.id}.json`), lesson);
  commitAndPush(clone, `lessons(${app}): ${lessons.map(l => l.id).join(', ')}`, `HEAD:refs/heads/${branch}`);
  const body = lessons.map(l => `- **${l.id}** (${l.level}, ${l.features.join(', ')}) ${l.title} — bug: ${l.bugs.join(', ')}`).join('\n');
  const gh = spawnSync(process.env.LEARN_APP_GH || 'gh', ['pr', 'create', '--repo', MEMORY_REPO, '--base', 'main', '--head', branch, '--title', `Bài học từ bug ${app}`, '--body', `Dev duyệt: merge thì bài học có hiệu lực cho các app sau.\n\n${body}`], { encoding: 'utf8', timeout: 60000 });
  if (gh.status !== 0) throw new Error(`đã đẩy branch ${branch} nhưng chưa mở được PR (${(gh.stderr || gh.stdout || '').trim().split('\n')[0]}). Bug chưa được đẩy — sửa gh (gh auth login) rồi chạy lại lessons-publish; có thể xoá branch ${branch}`);
  return gh.stdout.trim().split('\n').pop();
}

function publishBugs(clone, app, bugs, renamed, complete) {
  return onMain(clone, `bugs(${app}): ${bugs.length} bug`, () => {
    const bugsDir = path.join(clone, 'apps', app, 'bugs');
    fs.mkdirSync(bugsDir, { recursive: true });
    for (const bug of bugs) writeJsonAtomic(path.join(bugsDir, `${bug.data.key}.json`), { ...bug.data, lessonId: renamed[bug.data.lessonId] || bug.data.lessonId || null });
    if (complete) writeJsonAtomic(path.join(bugsDir, '_cursor.json'), { since: new Date().toISOString().slice(0, 10) });
    const appFile = path.join(clone, 'apps', app, 'app.json');
    const snapshot = readJson(appFile, null);
    if (snapshot) writeJsonAtomic(appFile, { ...snapshot, bugs: T.bugCounts(clone, app) });
    T.rebuildIndex(clone);
    return true;
  });
}

function publish(app, outDir) {
  return withMemory(clone => {
    const { merged, pending } = knownLessons(clone);
    const out = readOut(outDir, app, new Set([...merged, ...pending].map(l => l.id)));
    if (out.errors.length) return { ok: false, errors: out.errors };
    const drafts = out.lessons.map(l => l.data.id).filter(id => id.startsWith('new-'));
    const renamed = reserveIds(clone, drafts);
    const lessons = out.lessons.map(l => ({ ...l.data, id: renamed[l.data.id] || l.data.id }));
    const pr = lessons.length ? openLessonsPr(clone, app, lessons) : null;
    if (out.bugs.length || out.meta.complete) publishBugs(clone, app, out.bugs, renamed, out.meta.complete);
    return { ok: true, bugs: out.bugs.length, cursorMoved: out.meta.complete, lessonsNew: Object.values(renamed), lessonsUpdated: lessons.map(l => l.id).filter(id => !Object.values(renamed).includes(id)), pr };
  });
}

function syncLessons(root) {
  return withMemory(clone => {
    const target = path.join(root, DIR, 'lessons');
    const all = jsonFiles(path.join(clone, 'lessons')).map(n => ({ n, data: readJson(path.join(clone, 'lessons', n), null) }));
    const skipped = all.filter(l => !l.data || validate(schema('lesson.schema.json'), l.data).length).map(l => l.n);
    const active = all.filter(l => l.data && !skipped.includes(l.n) && l.data.status === 'active').map(l => l.data);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const lesson of active) writeJsonAtomic(path.join(target, `${lesson.id}.json`), lesson);
    writeJsonAtomic(path.join(target, '_synced.json'), { at: new Date().toISOString(), lessons: active.map(l => l.id), skipped });
    return { synced: active.map(l => l.id), skipped };
  });
}

function skipLessons(root, reason) {
  const target = path.join(root, DIR, 'lessons');
  fs.mkdirSync(target, { recursive: true });
  writeJsonAtomic(path.join(target, '_synced.json'), { at: new Date().toISOString(), lessons: [], skipped: [], skippedBecause: reason });
  return { synced: [], skippedBecause: reason };
}

module.exports = { prepare, publish, syncLessons, skipLessons, FIRST_LOOKBACK_DAYS };
