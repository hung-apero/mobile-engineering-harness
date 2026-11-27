const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { g, readyWorld } = require('./bugs-git-fixtures.cjs');
const { versionWorktree } = require('../src/bugs/landing.cjs');

const VERIFY = path.join(__dirname, '..', 'src', 'verify-tree.cjs');

test('the tree check passes only at the exact commit with no tracked change', async t => {
  const w = await readyWorld(t);
  const { tree } = await versionWorktree({ ...w.ctx, batchId: 1, sha: w.startSha });
  const check = sha => spawnSync(process.execPath, [VERIFY, sha], { cwd: tree, encoding: 'utf8' });
  fs.writeFileSync(path.join(tree, 'build.log'), 'x');
  assert.equal(check(w.startSha).status, 0);
  assert.equal(check('1'.repeat(40)).status, 1);
  fs.writeFileSync(path.join(tree, 'a.txt'), 'đổi');
  const dirty = check(w.startSha);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /a\.txt/);
  g(tree, 'add', 'a.txt');
  assert.equal(check(w.startSha).status, 1);
});
