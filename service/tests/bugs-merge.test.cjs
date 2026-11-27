const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mergeBatch, revertMerge } = require('../src/bugs/merge.cjs');
const { ensureMirror, ensureClone } = require('../src/bugs/workspace.cjs');
const { g, commit, readyWorld, gitBefore } = require('./bugs-git-fixtures.cjs');

const tmpOf = w => path.join(w.dzHome, 'workspaces', 'AAP1', 'tmp');
function assertClean(w) {
  assert.deepEqual(fs.existsSync(tmpOf(w)) ? fs.readdirSync(tmpOf(w)) : [], []);
  assert.equal(g(w.mirror, 'worktree', 'list').split('\n').length, 1);
}
async function moveBase(w, files) {
  const sha = commit(w.dev, files, 'base');
  g(w.dev, 'push', '-q', 'origin', 'develop');
  await ensureMirror(w.ctx);
  return sha;
}

test('mergeBatch merges the base first and then each lane with its own merge commit', async t => {
  const w = await readyWorld(t);
  const one = w.lane('fix/one', { 'one.txt': '1\n' });
  const two = w.lane('fix/two', { 'two.txt': '2\n' });
  const base = await moveBase(w, { 'base.txt': 'b\n' });
  const out = await mergeBatch({ ...w.merge, branches: ['fix/two', { branch: 'fix/one', commit: one }] });
  assert.equal(out.ok, true);
  assert.equal(w.ref(w.branch), out.sha);
  assert.deepEqual(out.merged.map(m => [m.branch, m.commit]), [['fix/two', two], ['fix/one', one]]);
  const chain = g(w.mirror, 'rev-list', '--first-parent', out.sha).split('\n');
  assert.deepEqual(chain.slice(0, 4), [out.merged[1].mergeSha, out.merged[0].mergeSha, out.baseMerge, out.before]);
  assert.equal(g(w.mirror, 'rev-parse', `${out.baseMerge}^2`), base);
  assert.equal(g(w.mirror, 'log', '-1', '--format=%an <%ae>', out.sha), 'dev-zone <dev-zone@localhost>');
  for (const name of ['one.txt', 'two.txt', 'base.txt']) assert.ok(w.file(name));
  assert.equal(w.ref('develop'), base);
  assertClean(w);
});

test('a lane conflict changes no ref and names the lane and the files', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'a.txt': 'one\n' });
  w.lane('fix/two', { 'a.txt': 'two\n' });
  const before = w.refs();
  const out = await mergeBatch({ ...w.merge, branches: ['fix/one', 'fix/two'] });
  assert.deepEqual(out, { ok: false, conflictsWith: 'fix/two', files: ['a.txt'], skipped: [] });
  assert.equal(w.refs(), before);
  assertClean(w);
});

test('a base conflict changes no ref, also when skipping conflicts', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'a.txt': 'one\n' });
  await mergeBatch({ ...w.merge, branches: ['fix/one'] });
  w.lane('fix/two', { 'b.txt': 'two\n' });
  await moveBase(w, { 'a.txt': 'base\n' });
  const before = w.refs();
  for (const skipConflicting of [false, true]) {
    const out = await mergeBatch({ ...w.merge, branches: ['fix/two'], skipConflicting });
    assert.deepEqual([out.ok, out.conflictsWith, out.files], [false, 'base', ['a.txt']]);
  }
  assert.equal(w.refs(), before);
  assertClean(w);
});

test('skipConflicting merges what it can on the accumulated result and reports the rest', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'a.txt': 'one\n' });
  w.lane('fix/two', { 'a.txt': 'two\n', 'two.txt': '2\n' });
  w.lane('fix/three', { 'b.txt': 'three\n' });
  const out = await mergeBatch({ ...w.merge, branches: ['fix/one', 'fix/two', 'fix/three'], skipConflicting: true });
  assert.deepEqual(out.merged.map(m => m.branch), ['fix/one', 'fix/three']);
  assert.deepEqual(out.skipped, [{ branch: 'fix/two', code: 'conflict', files: ['a.txt'] }]);
  assert.equal(w.file('a.txt'), 'one');
  assert.throws(() => w.file('two.txt'));
  assertClean(w);
});

test('lanes that are missing, moved, badly named, empty or not descendants are reported and not merged', async t => {
  const w = await readyWorld(t);
  w.lane('fix/empty', {});
  const moved = w.lane('fix/moved', { 'a.txt': '1\n' });
  w.lane('fix/moved2', { 'b.txt': '1\n' });
  g(w.repo, 'checkout', '-q', '--orphan', 'alone');
  g(w.repo, 'push', '-q', 'origin', `${commit(w.repo, { 'c.txt': 'c\n' })}:refs/heads/fix/alone`);
  g(w.mirror, 'update-ref', 'refs/heads/fix/same', w.startSha);
  const before = w.refs();
  const names = ['fix/empty', 'fix/same', 'fix/alone', 'fix/none', 'develop', 'fix/../x', 'fix/-x', '--abort', `fix/${'a'.repeat(82)}`];
  const out = await mergeBatch({ ...w.merge, branches: [...names, { branch: 'fix/moved2', commit: moved }] });
  assert.deepEqual(out.skipped.map(s => s.code), ['no_diff', 'no_diff', 'not_descendant', 'missing', 'invalid_name', 'invalid_name', 'invalid_name', 'invalid_name', 'invalid_name', 'moved']);
  assert.deepEqual([out.ok, out.sha, out.merged], [true, out.before, []]);
  assert.equal(w.refs(), before);
});

test('a lane from the batch start still merges after another batch moved the version branch', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'one.txt': '1\n' });
  w.lane('fix/two', { 'two.txt': '2\n' });
  await mergeBatch({ ...w.merge, branches: ['fix/one'] });
  const strict = await mergeBatch({ ...w.merge, startSha: undefined, branches: ['fix/two'] });
  assert.deepEqual(strict.skipped, [{ branch: 'fix/two', code: 'not_descendant' }]);
  const out = await mergeBatch({ ...w.merge, branches: ['fix/two'] });
  assert.deepEqual(out.merged.map(m => m.branch), ['fix/two']);
});

test('running mergeBatch again after a crash reports the earlier merge and changes nothing', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'one.txt': '1\n' });
  const first = await mergeBatch({ ...w.merge, branches: ['fix/one'] });
  const again = await mergeBatch({ ...w.merge, branches: ['fix/one'] });
  assert.deepEqual(again.skipped, [{ branch: 'fix/one', code: 'already_merged', mergeSha: first.merged[0].mergeSha }]);
  assert.equal(again.sha, first.sha);
  assert.equal(w.ref(w.branch), first.sha);
});

test('a version branch that moved during the merge is never overwritten', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'one.txt': '1\n' });
  const other = g(w.mirror, 'rev-parse', 'refs/heads/fix/one');
  const git = gitBefore('update-ref', () => g(w.mirror, 'update-ref', `refs/heads/${w.branch}`, other));
  await assert.rejects(mergeBatch({ ...w.merge, branches: ['fix/one'], git }), { code: 'REF_MOVED' });
  assert.equal(w.ref(w.branch), other);
  assertClean(w);
});

test('a git failure that is not a conflict is an error, changes no ref and leaves no worktree', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'one.txt': '1\n' });
  const before = w.refs();
  const git = gitBefore('merge', () => { throw new Error('hỏng'); });
  await assert.rejects(mergeBatch({ ...w.merge, branches: ['fix/one'], git }), /hỏng/);
  assert.equal(w.refs(), before);
  assertClean(w);
});

test('hooks planted on the mirror do not run in service merges', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'one.txt': '1\n' });
  const mark = path.join(w.root, 'ran');
  for (const name of ['post-checkout', 'pre-merge-commit', 'commit-msg', 'post-merge', 'reference-transaction']) {
    fs.writeFileSync(path.join(w.mirror, 'hooks', name), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
  }
  await mergeBatch({ ...w.merge, branches: ['fix/one'] });
  assert.equal(fs.existsSync(mark), false);
});

test('revertMerge adds one revert commit, and a second call changes nothing', async t => {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'a.txt': 'one\n' });
  w.lane('fix/two', { 'b.txt': 'two\n' });
  const { merged, sha } = await mergeBatch({ ...w.merge, branches: ['fix/one', 'fix/two'] });
  const out = await revertMerge({ ...w.merge, mergeSha: merged[0].mergeSha });
  assert.deepEqual([out.ok, out.already, out.before, out.sha], [true, false, sha, w.ref(w.branch)]);
  assert.equal(g(w.mirror, 'rev-parse', `${out.sha}^`), sha);
  assert.deepEqual([w.file('a.txt'), w.file('b.txt')], ['a', 'two']);
  const again = await revertMerge({ ...w.merge, mergeSha: merged[0].mergeSha });
  assert.deepEqual([again.already, again.revertSha, w.ref(w.branch)], [true, out.sha, out.sha]);
  const retried = await mergeBatch({ ...w.merge, branches: ['fix/one'] });
  assert.equal(retried.skipped[0].code, 'reverted');
  assertClean(w);
});

test('revertMerge reports conflicts, keeps the ref on a race and refuses other commits', async t => {
  const w = await readyWorld(t);
  const lane = w.lane('fix/one', { 'a.txt': 'one\n' });
  const { merged, sha } = await mergeBatch({ ...w.merge, branches: ['fix/one'] });
  const git = gitBefore('update-ref', () => g(w.mirror, 'update-ref', `refs/heads/${w.branch}`, lane));
  await assert.rejects(revertMerge({ ...w.merge, mergeSha: sha, git }), { code: 'REF_MOVED' });
  g(w.mirror, 'update-ref', `refs/heads/${w.branch}`, sha);
  for (const mergeSha of [lane, w.startSha, 'HEAD', undefined]) await assert.rejects(revertMerge({ ...w.merge, mergeSha }), { code: 'INVALID' });
  const { startSha, repo } = await ensureClone({ ...w.ctx, batch: { id: 2, version: '1.9.2' } });
  g(repo, 'push', '-q', 'origin', `${commit(repo, { 'a.txt': 'later\n' })}:refs/heads/fix/later`);
  const later = await mergeBatch({ ...w.merge, startSha, branches: ['fix/later'] });
  assert.deepEqual(await revertMerge({ ...w.merge, mergeSha: merged[0].mergeSha }), { ok: false, conflictsWith: merged[0].mergeSha, files: ['a.txt'] });
  assert.equal(w.ref(w.branch), later.sha);
  assertClean(w);
});
