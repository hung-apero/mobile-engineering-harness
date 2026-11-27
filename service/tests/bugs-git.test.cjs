const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGit } = require('../src/bugs/git.cjs');

const read = async (name, options) => (await runGit(['config', '--get', name], { cwd: os.tmpdir(), okCodes: [0, 1], ...options })).stdout.trim();

function withEnv(t, values) {
  const old = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('local git ignores the user configuration and inherited git variables', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-gitcfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, '[user]\n\tname = someone\n[core]\n\thooksPath = /tmp/hooks\n[dz]\n\tmark = yes\n');
  withEnv(t, { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'dz.mark', GIT_CONFIG_VALUE_0: 'env', GIT_DIR: dir });
  assert.equal(await read('dz.mark'), '');
  assert.deepEqual([await read('user.name'), await read('user.email'), await read('core.hooksPath')], ['dev-zone', 'dev-zone@localhost', '/dev/null']);
});

test('remote git keeps the user identity but still runs no hook', async () => {
  assert.equal(await read('core.hooksPath', { remote: true }), '/dev/null');
  assert.notEqual(await read('user.email', { remote: true }), 'dev-zone@localhost');
});

test('a git command over its time limit is killed and is an error', async () => {
  const started = Date.now();
  await assert.rejects(runGit(['-c', 'alias.wait=!exec sleep 20', 'wait'], { cwd: os.tmpdir(), timeoutMs: 300 }), /quá 300 ms/);
  assert.ok(Date.now() - started < 10000);
});

test('an exit code that was not allowed is an error with its code', async () => {
  await assert.rejects(runGit(['rev-parse', '--verify', 'none'], { cwd: os.tmpdir() }), { name: 'GitError', code: 128 });
});
