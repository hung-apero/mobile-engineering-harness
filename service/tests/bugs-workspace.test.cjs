const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGit } = require('../src/bugs/git.cjs');
const { versionBranch, ensureMirror, ensureVersionBranch, ensureClone } = require('../src/bugs/workspace.cjs');
const { g, commit, world, readyWorld } = require('./bugs-git-fixtures.cjs');

const batch = { id: 7, version: '1.9.2' };

test('versionBranch accepts a version and refuses anything git could misread', () => {
  assert.equal(versionBranch('1.9.2'), 'dz/release-1.9.2');
  for (const bad of ['', 'x1', '1..2', '1.lock', '1.', '1/2', '1 2', '1:2', '-1', undefined]) assert.throws(() => versionBranch(bad), /không hợp lệ/);
});

test('ensureMirror builds a bare mirror and follows the base branch', async t => {
  const w = world(t);
  const first = await ensureMirror(w.ctx);
  assert.equal(first.mirror, w.mirror);
  assert.equal(first.baseSha, g(w.dev, 'rev-parse', 'HEAD'));
  const next = commit(w.dev, { 'a.txt': 'a2\n' });
  g(w.dev, 'push', '-q', 'origin', 'develop');
  assert.equal((await ensureMirror(w.ctx)).baseSha, next);
  assert.equal(g(w.mirror, 'rev-parse', '--is-bare-repository'), 'true');
});

test('fetch neither prunes nor overwrites fix and dz refs on the mirror', async t => {
  const w = await readyWorld(t);
  const lane = w.lane('fix/one', { 'a.txt': 'one\n' });
  const version = w.ref(w.branch);
  g(w.dev, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/one', 'HEAD:refs/heads/extra');
  commit(w.dev, { 'a.txt': 'github\n' });
  g(w.dev, 'push', '-q', 'origin', `HEAD:refs/heads/${w.branch}`, 'HEAD:refs/heads/develop');
  await ensureMirror(w.ctx);
  await ensureVersionBranch({ ...w.ctx, version: '1.9.2' });
  assert.equal(w.ref('fix/one'), lane);
  assert.equal(w.ref(w.branch), version);
  assert.doesNotMatch(w.refs(), /extra/);
});

test('only fetch and push run with the user git configuration', async t => {
  const w = world(t);
  const calls = [];
  const git = (args, options) => {
    calls.push([args[0], options?.remote === true]);
    return runGit(args, options);
  };
  await ensureMirror({ ...w.ctx, git });
  await ensureVersionBranch({ ...w.ctx, version: '1.9.2', git });
  await ensureClone({ ...w.ctx, batch, git });
  assert.deepEqual([...new Set(calls.filter(c => c[1]).map(c => c[0]))].sort(), ['fetch', 'ls-remote']);
});

test('the derived GitHub URL comes from project.repo and a bad repo or base is refused', async t => {
  const w = world(t);
  const urls = [];
  const git = (args, options) => {
    if (args[0] !== 'fetch') return runGit(args, options);
    urls.push(args.at(-2));
    return { code: 0, stdout: '', stderr: '' };
  };
  await ensureMirror({ ...w.ctx, githubUrl: undefined, git });
  assert.deepEqual(urls, ['https://github.com/Apero/AAP1.git']);
  for (const bad of [{ repo: '--upload-pack=x/y' }, { base: '-x' }, { base: 'dz/release-1' }, { base: 'a..b' }, { key: '../x' }]) {
    await assert.rejects(ensureMirror({ ...w.ctx, githubUrl: undefined, project: { ...w.project, ...bad }, git }), { code: 'INVALID' });
  }
});

test('the version branch starts at the base, or at the GitHub copy when there is one', async t => {
  const w = world(t);
  const { baseSha } = await ensureMirror(w.ctx);
  assert.deepEqual(await ensureVersionBranch({ ...w.ctx, version: '1.0' }), { branch: 'dz/release-1.0', sha: baseSha, created: true });
  const sha = commit(w.dev, { 'a.txt': 'released\n' });
  g(w.mirror, 'update-ref', 'refs/heads/fix/one', baseSha);
  g(w.dev, 'push', '-q', 'origin', 'HEAD:refs/heads/dz/release-2.0', 'HEAD:refs/heads/develop', 'HEAD:refs/heads/fix/one');
  assert.deepEqual(await ensureVersionBranch({ ...w.ctx, version: '2.0' }), { branch: 'dz/release-2.0', sha, created: true });
  assert.deepEqual(await ensureVersionBranch({ ...w.ctx, version: '2.0' }), { branch: 'dz/release-2.0', sha, created: false });
  for (const name of ['develop', 'fix/one', 'dz/release-1.0']) assert.equal(g(w.mirror, 'rev-parse', `refs/heads/${name}`), baseSha);
});

test('the mirror takes only fix branches from a worker push', async t => {
  const w = await readyWorld(t);
  const before = w.refs();
  const sha = commit(w.repo, { 'a.txt': 'x\n' });
  for (const ref of ['develop', w.branch, 'other']) assert.throws(() => g(w.repo, 'push', '-q', 'origin', `${sha}:refs/heads/${ref}`));
  assert.equal(w.refs(), before);
  g(w.repo, 'push', '-q', 'origin', `${sha}:refs/heads/fix/ok`);
  assert.equal(w.ref('fix/ok'), sha);
});

test('ensureClone checks out the version branch with the mirror as origin and is idempotent', async t => {
  const w = world(t);
  const { baseSha, mirror } = await ensureMirror(w.ctx);
  await ensureVersionBranch({ ...w.ctx, version: '1.9.2' });
  const first = await ensureClone({ ...w.ctx, batch });
  assert.equal(first.repo, path.join(w.dzHome, 'workspaces', 'AAP1', 'batches', '7', 'repo'));
  assert.equal(first.startSha, baseSha);
  assert.equal(g(first.repo, 'remote', 'get-url', 'origin'), mirror);
  assert.equal(g(first.repo, 'branch', '--show-current'), 'dz/release-1.9.2');
  commit(first.repo, { 'work.txt': 'worker\n' });
  assert.deepEqual(await ensureClone({ ...w.ctx, batch }), first);
  assert.equal(fs.readFileSync(path.join(first.repo, 'work.txt'), 'utf8'), 'worker\n');
});

test('ensureClone recovers from a half made clone and refuses a foreign origin or a bad id', async t => {
  const w = await readyWorld(t);
  const dir = path.join(w.dzHome, 'workspaces', 'AAP1', 'batches', '7');
  fs.mkdirSync(path.join(dir, 'repo.partial'), { recursive: true });
  const { repo } = await ensureClone({ ...w.ctx, batch });
  g(repo, 'remote', 'set-url', 'origin', w.github);
  await assert.rejects(ensureClone({ ...w.ctx, batch }), { code: 'ORIGIN' });
  for (const id of ['..', '', 'a/b', undefined]) await assert.rejects(ensureClone({ ...w.ctx, batch: { ...batch, id } }), { code: 'INVALID' });
});

test('the harness is linked into .claude and hidden from git', async t => {
  const w = await readyWorld(t);
  const claude = path.join(w.repo, '.claude');
  assert.deepEqual(fs.readdirSync(path.join(claude, 'skills')).sort(), ['bug', 'bug-fix', 'feature', 'harness-init', 'spec-clear']);
  assert.equal(fs.readlinkSync(path.join(claude, 'skills', 'bug')), path.join(w.harness, 'skills', 'bug'));
  assert.deepEqual(fs.readdirSync(path.join(claude, 'agents')).sort(), ['bug-fixer.md', 'bug-reviewer.md', 'bug-scout.md', 'ui-board-judge.md']);
  assert.equal(g(w.repo, 'status', '--porcelain'), '');
  await ensureClone({ ...w.ctx, batch: { id: 1, version: '1.9.2' } });
  const exclude = fs.readFileSync(path.join(w.repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter(line => line === '.claude/').length, 1);
});

test('a harness at another commit, edited, or missing is an error', async t => {
  const w = await readyWorld(t);
  const again = project => ensureClone({ ...w.ctx, project: { ...w.project, ...project }, batch: { id: 1, version: '1.9.2' } });
  await again({ harnessCommit: w.project.harnessCommit.slice(0, 8) });
  fs.writeFileSync(path.join(w.harness, 'agents', 'bug-fixer.md'), 'edited\n');
  await assert.rejects(again({}), { code: 'HARNESS' });
  commit(w.harness, {});
  await assert.rejects(again({}), { code: 'HARNESS' });
  fs.rmSync(w.harness, { recursive: true });
  await assert.rejects(again({}), { code: 'HARNESS' });
});

test('a repo whose .claude is a symlink is refused', async t => {
  const w = world(t);
  commit(w.dev, { '.claude': { symlinkTo: w.root } });
  g(w.dev, 'push', '-q', 'origin', 'develop');
  await ensureMirror(w.ctx);
  await ensureVersionBranch({ ...w.ctx, version: '1.9.2' });
  await assert.rejects(ensureClone({ ...w.ctx, batch }), { code: 'UNSAFE_PATH' });
  assert.equal(fs.existsSync(path.join(w.root, 'skills')), false);
});

test('local files are copied from the checkout and never become tracked', async t => {
  const w = await readyWorld(t);
  fs.mkdirSync(path.join(w.checkout, 'app'));
  fs.writeFileSync(path.join(w.checkout, 'local.properties'), 'sdk=1\n');
  fs.writeFileSync(path.join(w.checkout, 'app', 'keys.json'), '{}\n');
  const project = { ...w.project, localFiles: ['local.properties', 'app/keys.json'] };
  const { repo } = await ensureClone({ ...w.ctx, project, batch });
  assert.equal(fs.readFileSync(path.join(repo, 'app', 'keys.json'), 'utf8'), '{}\n');
  assert.equal(g(repo, 'status', '--porcelain'), '');
  fs.writeFileSync(path.join(repo, 'local.properties'), 'sdk=worker\n');
  await ensureClone({ ...w.ctx, project, batch });
  assert.equal(fs.readFileSync(path.join(repo, 'local.properties'), 'utf8'), 'sdk=worker\n');
});

test('local files outside the checkout, symlinked, missing, tracked or unsafe are refused', async t => {
  const w = await readyWorld(t);
  fs.writeFileSync(path.join(w.root, 'outside'), 'x');
  fs.symlinkSync(path.join(w.root, 'outside'), path.join(w.checkout, 'link'));
  fs.symlinkSync(w.root, path.join(w.checkout, 'dir'));
  fs.mkdirSync(path.join(w.checkout, 'folder'));
  fs.writeFileSync(path.join(w.checkout, 'a.txt'), 'x');
  for (const name of ['../outside', path.join(w.root, 'outside'), 'link', 'dir/outside', 'folder', 'none', 'a.txt', '.git/config', 'a//b', '*']) {
    await assert.rejects(ensureClone({ ...w.ctx, project: { ...w.project, localFiles: [name] }, batch }), { code: 'LOCAL_FILE' }, name);
  }
});
