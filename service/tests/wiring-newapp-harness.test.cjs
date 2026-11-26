const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defaultDeps } = require('../src/newapp/default-deps.cjs');

function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'a'), '1');
  git('add', 'a');
  git('commit', '-q', '-m', 'one');
  return git('rev-parse', '--short', 'HEAD');
}

test('newapp harnessCommit is HEAD of $DZ_HOME/harness, not of the plugin repo', t => {
  const dzHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-nh-'));
  t.after(() => fs.rmSync(dzHome, { recursive: true, force: true }));
  const head = repo(path.join(dzHome, 'harness'));
  assert.equal(defaultDeps({ dzHome, secretsDir: path.join(dzHome, 'secrets') }).harnessCommit(), head);
});

test('newapp harnessCommit fails when $DZ_HOME/harness is not a git checkout', t => {
  const dzHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-nh-'));
  t.after(() => fs.rmSync(dzHome, { recursive: true, force: true }));
  assert.throws(() => defaultDeps({ dzHome, secretsDir: path.join(dzHome, 'secrets') }).harnessCommit());
});
