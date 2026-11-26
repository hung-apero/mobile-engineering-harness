const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { g, commit, readyWorld, gitBefore } = require('./bugs-git-fixtures.cjs');
const { mergeBatch } = require('../src/bugs/merge.cjs');
const landing = require('../src/bugs/landing.cjs');

async function merged(t) {
  const w = await readyWorld(t);
  w.lane('fix/aap1-1-1', { 'c.txt': 'c\n' });
  const result = await mergeBatch({ ...w.merge, branches: ['fix/aap1-1-1'] });
  const args = { ...w.ctx, versionBranch: w.branch, from: result.sha, to: result.before };
  return { w, result, args };
}

test('resetVersion moves the local ref back', async t => {
  const { w, result, args } = await merged(t);
  assert.deepEqual(await landing.resetVersion(args), { ok: true, already: false, sha: result.before });
  assert.equal(w.ref(w.branch), result.before);
});

test('resetVersion run again is a no-op', async t => {
  const { args } = await merged(t);
  await landing.resetVersion(args);
  assert.equal((await landing.resetVersion(args)).already, true);
});

test('resetVersion refuses a pushed sha', async t => {
  const { w, result, args } = await merged(t);
  g(w.mirror, 'push', '-q', w.github, `${result.sha}:refs/heads/${w.branch}`);
  await assert.rejects(landing.resetVersion(args), { code: 'PUSHED' });
  assert.equal(w.ref(w.branch), result.sha);
});

test('resetVersion refuses when GitHub is ahead of the sha', async t => {
  const { w, result, args } = await merged(t);
  g(w.mirror, 'push', '-q', w.github, `${result.sha}:refs/heads/${w.branch}`);
  g(w.dev, 'fetch', '-q', 'origin', w.branch);
  g(w.dev, 'checkout', '-q', 'FETCH_HEAD');
  commit(w.dev, { 'dev.txt': 'dev\n' });
  g(w.dev, 'push', '-q', 'origin', `HEAD:refs/heads/${w.branch}`);
  await assert.rejects(landing.resetVersion(args), { code: 'PUSHED' });
});

test('resetVersion refuses when part of the range is on GitHub', async t => {
  const { w, result, args } = await merged(t);
  const part = g(w.mirror, 'rev-parse', `${result.sha}^2`);
  g(w.mirror, 'push', '-q', w.github, `${part}:refs/heads/${w.branch}`);
  await assert.rejects(landing.resetVersion(args), { code: 'PUSHED' });
});

test('resetVersion allows reset when GitHub holds only the older tip', async t => {
  const { w, result, args } = await merged(t);
  g(w.mirror, 'push', '-q', w.github, `${result.before}:refs/heads/${w.branch}`);
  assert.equal((await landing.resetVersion(args)).ok, true);
});

test('resetVersion does not overwrite a ref that moved', async t => {
  const { w, result, args } = await merged(t);
  const other = commit(w.repo, { 'z.txt': 'z\n' });
  g(w.repo, 'push', '-q', 'origin', `${other}:refs/heads/fix/z`);
  const git = gitBefore('update-ref', () => g(w.mirror, 'update-ref', `refs/heads/${w.branch}`, other));
  await assert.rejects(landing.resetVersion({ ...args, git }), { code: 'REF_MOVED' });
  assert.equal(w.ref(w.branch), other);
  await assert.rejects(landing.resetVersion({ ...args, to: result.before }), { code: 'REF_MOVED' });
});

test('versionWorktree checks out the sha, copies localFiles and is reused', async t => {
  const { w, result } = await merged(t);
  fs.writeFileSync(path.join(w.checkout, 'local.properties'), 'sdk=1\n');
  const project = { ...w.project, localFiles: ['local.properties'] };
  const args = { dzHome: w.dzHome, project, batchId: 1 };
  const { tree } = await landing.versionWorktree({ ...args, sha: result.sha });
  assert.equal(fs.readFileSync(path.join(tree, 'c.txt'), 'utf8'), 'c\n');
  assert.equal(fs.readFileSync(path.join(tree, 'local.properties'), 'utf8'), 'sdk=1\n');
  fs.rmSync(path.join(tree, 'a.txt'));
  fs.mkdirSync(path.join(tree, 'build'));
  await landing.versionWorktree({ ...args, sha: result.before, reuse: true });
  assert.equal(fs.existsSync(path.join(tree, 'build')), true);
  assert.equal(fs.existsSync(path.join(tree, 'a.txt')), true);
  assert.equal(fs.existsSync(path.join(tree, 'c.txt')), false);
  await landing.removeWorktree(args);
  assert.equal(fs.existsSync(tree), false);
  assert.equal(g(w.mirror, 'worktree', 'list', '--porcelain').includes('gate'), false);
});

test('versionWorktree replaces whatever was at its path unless told to reuse', async t => {
  const { w, result } = await merged(t);
  const tree = path.join(w.dzHome, 'workspaces', 'AAP1', 'batches', '1', 'review');
  fs.mkdirSync(path.join(tree, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tree, '.claude', 'settings.json'), '{}');
  await landing.versionWorktree({ dzHome: w.dzHome, project: w.project, batchId: 1, name: 'review', sha: result.sha, localFiles: false });
  assert.deepEqual(fs.readdirSync(tree).sort(), ['.git', '.gitignore', 'a.txt', 'b.txt', 'c.txt']);
});

test('versionWorktree with reuse recovers from a broken tree', async t => {
  const { w, result } = await merged(t);
  const args = { dzHome: w.dzHome, project: w.project, batchId: 1, sha: result.sha, reuse: true };
  const { tree } = await landing.versionWorktree(args);
  fs.rmSync(path.join(tree, '.git'));
  await landing.versionWorktree(args);
  assert.equal(g(tree, 'rev-parse', 'HEAD'), result.sha);
});

test('versionWorktree refuses a batch directory that is a symlink', async t => {
  const { w, result } = await merged(t);
  const dir = path.join(w.dzHome, 'workspaces', 'AAP1', 'batches', '9');
  fs.symlinkSync(w.checkout, dir);
  await assert.rejects(landing.versionWorktree({ dzHome: w.dzHome, project: w.project, batchId: 9, sha: result.sha }), { code: 'UNSAFE_PATH' });
});

test('laneState wants the commit to be the branch tip on the mirror and to descend from startSha', async t => {
  const w = await readyWorld(t);
  const sha = w.lane('fix/aap1-1-1', { 'c.txt': 'c\n' });
  const args = { ...w.ctx, branch: 'fix/aap1-1-1', commit: sha, startSha: w.startSha };
  assert.deepEqual(await landing.laneState(args), { ok: true, commits: [{ sha, parent: w.startSha }] });
  assert.equal((await landing.laneState({ ...args, commit: w.startSha })).ok, false);
  assert.equal((await landing.laneState({ ...args, branch: 'fix/none' })).ok, false);
  const later = commit(w.repo, { 'd.txt': 'd\n' });
  g(w.repo, 'push', '-q', 'origin', `${later}:refs/heads/fix/later`);
  assert.equal((await landing.laneState({ ...args, startSha: later })).ok, false);
});

test('diffLines counts added and removed lines against the base', async t => {
  const { w, result } = await merged(t);
  assert.equal(await landing.diffLines({ ...w.ctx, base: 'develop', sha: result.sha }), 1);
});

test('changedFiles is the union of the lane diffs', async t => {
  const w = await readyWorld(t);
  const one = w.lane('fix/aap1-1-1', { 'c.txt': 'c\n', 'a.txt': 'x\n' });
  const two = w.lane('fix/aap1-2-1', { 'd.txt': 'd\n', 'a.txt': 'y\n' });
  assert.deepEqual(await landing.changedFiles({ ...w.ctx, from: w.startSha, commits: [one, two] }), ['a.txt', 'c.txt', 'd.txt']);
});

test('the mirror refuses a non fast-forward lane push', async t => {
  const w = await readyWorld(t);
  w.lane('fix/aap1-1-1', { 'c.txt': 'c\n' });
  g(w.repo, 'checkout', '-q', '-B', 'fix/aap1-1-1', w.startSha);
  commit(w.repo, { 'c.txt': 'other\n' });
  assert.throws(() => g(w.repo, 'push', '-q', '--force', 'origin', 'HEAD:refs/heads/fix/aap1-1-1'), /non-fast-forward/);
});
