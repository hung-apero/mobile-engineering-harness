const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR = '.learn-app';
const MAX = 4 * 1024 * 1024;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

function realParent(repo, rel, create = false) {
  let dir = fs.realpathSync(repo);
  for (const part of path.dirname(path.join(DIR, rel)).split(path.sep)) {
    dir = path.join(dir, part);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat && create) fs.mkdirSync(dir);
    else if (!stat) return null;
    else if (!stat.isDirectory()) throw new Error(`${rel} không nằm trong thư mục thật`);
  }
  return path.join(dir, path.basename(rel));
}

function read(repo, rel) {
  const file = realParent(repo, rel);
  if (!file || !fs.lstatSync(file, { throwIfNoEntry: false })) return null;
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX) throw new Error(`${rel} không phải file thường hoặc quá lớn`);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function write(repo, rel, text) {
  const file = realParent(repo, rel, true);
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, text, { flag: 'wx' });
  fs.renameSync(temp, file);
}

function remove(repo, rel) {
  const file = realParent(repo, rel);
  if (file) fs.rmSync(file, { force: true });
}

function readJson(repo, rel) {
  const text = read(repo, rel);
  if (text === null) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function specVersions(repo) {
  const probe = realParent(repo, 'inputs/x');
  if (!probe) return [];
  return fs.readdirSync(path.dirname(probe)).map(name => name.match(/^spec-v(\d{1,6})\.md$/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

function specAt(repo, version) {
  const markdown = read(repo, `inputs/spec-v${version}.md`);
  return markdown === null ? null : { version, markdown, sha: sha256(markdown) };
}

function latestSpec(repo) {
  const version = specVersions(repo).at(-1);
  return version === undefined ? null : specAt(repo, version);
}

module.exports = { read, write, remove, readJson, specVersions, specAt, latestSpec, sha256 };
