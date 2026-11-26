const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const kv = require('../kv.cjs');
const { runGit, check, pathsFor, SHA } = require('../bugs/git.cjs');
const { checkVersion } = require('../bugs/store.cjs');

const KEEP = 30;
const KEEP_APK = 2;
const buildsKey = (project, version) => `e2e-builds:${project}:${version}`;

async function treeOf({ dzHome, project, sha, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  const { stdout } = await git(['rev-parse', '--verify', '--end-of-options', `${check(SHA, sha, 'sha')}^{tree}`], { gitDir: mirror });
  return check(SHA, stdout.trim(), 'tree');
}

function e2eRoot({ dzHome, project, version }) {
  checkVersion(version);
  if (version.includes('..')) throw new Error(`version không hợp lệ: ${version}`);
  return path.join(pathsFor({ dzHome, project }).root, 'e2e', version);
}

function realDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(dir) !== dir) throw new Error(`${dir} phải là thư mục thật`);
  return dir;
}

async function sha256Of(file) {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const listBuilds = (db, project, version) => kv.get(db, buildsKey(project, version)) ?? [];

async function copyApk(build, dir) {
  const target = path.join(dir, `${build.sha256}.apk`);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.copyFile(build.path, temp, fs.constants.COPYFILE_FICLONE);
  if ((await sha256Of(temp)) !== build.sha256) {
    fs.rmSync(temp, { force: true });
    throw new Error('APK đã đổi sau khi build');
  }
  fs.renameSync(temp, target);
  return target;
}

function pruneApks(dir, entries) {
  const kept = new Set(entries.map(entry => entry.apk).filter(Boolean));
  for (const name of fs.readdirSync(dir)) if (!kept.has(path.join(dir, name))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
}

async function keepBuild({ db, dzHome, project, version, batchId, sha, build, now }) {
  const known = listBuilds(db, project.key, version);
  if (known.some(entry => entry.batchId === batchId)) return known;
  const tree = await treeOf({ dzHome, project, sha });
  const dir = realDir(path.join(e2eRoot({ dzHome, project, version }), 'builds'));
  const apk = await copyApk(build, dir);
  const entry = { batchId, sha, tree, apk, sha256: build.sha256, versionName: build.versionName ?? null, at: now };
  const all = [...known, entry].slice(-KEEP);
  const next = all.map((old, index) => (index < all.length - KEEP_APK ? { ...old, apk: null } : old));
  kv.set(db, buildsKey(project.key, version), next, now);
  pruneApks(dir, next);
  return next;
}

function buildFor(db, project, version, tree) {
  const last = listBuilds(db, project, version).findLast(entry => entry.tree === tree && entry.apk);
  return last && fs.lstatSync(last.apk, { throwIfNoEntry: false })?.isFile() ? last : null;
}

module.exports = { treeOf, e2eRoot, realDir, sha256Of, listBuilds, keepBuild, buildFor, buildsKey };
