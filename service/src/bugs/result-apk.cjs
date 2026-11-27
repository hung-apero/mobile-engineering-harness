const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 1024 * 1024;
const META_MAX = 1024 * 1024;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

function checkGlob(apkGlob) {
  if (typeof apkGlob !== 'string' || !apkGlob || path.isAbsolute(apkGlob) || apkGlob.split(/[\\/]/).includes('..')) throw new Error('apkGlob phải là đường dẫn tương đối trong worktree');
}

function candidates(worktree, apkGlob) {
  checkGlob(apkGlob);
  const root = fs.realpathSync(worktree);
  return fs.globSync(apkGlob, { cwd: root })
    .map(name => path.resolve(root, name))
    .filter(file => file.startsWith(root + path.sep) && fs.lstatSync(file).isFile() && fs.realpathSync(file) === file)
    .map(file => ({ file, stat: fs.statSync(file) }))
    .filter(({ stat }) => stat.size > 0)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

async function hashOf(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(CHUNK);
  const handle = await fs.promises.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  let bytes = 0;
  try {
    for (;;) {
      const { bytesRead: read } = await handle.read(buffer, 0, CHUNK, null);
      if (read === 0) return { sha256: hash.digest('hex'), bytes };
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    await handle.close();
  }
}

function readMetadata(dir) {
  const file = path.join(dir, 'output-metadata.json');
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size <= META_MAX ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

function versionOf(file) {
  const elements = readMetadata(path.dirname(file))?.elements;
  const element = Array.isArray(elements) ? elements.find(e => e?.outputFile === path.basename(file)) : null;
  return {
    ...(Number.isInteger(element?.versionCode) && { versionCode: element.versionCode }),
    ...(typeof element?.versionName === 'string' && { versionName: element.versionName.slice(0, 100) }),
  };
}

async function findApk({ worktree, apkGlob, sha }) {
  const [newest, second] = candidates(worktree, apkGlob);
  if (!newest) return { error: 'không tìm thấy APK' };
  if (second && second.stat.mtimeMs === newest.stat.mtimeMs) return { error: 'có nhiều APK mới như nhau' };
  return { apk: { path: newest.file, ...await hashOf(newest.file), commit: sha, ...versionOf(newest.file) } };
}

module.exports = { findApk };
