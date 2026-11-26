const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workerArgs, workerEnv, applyEnv } = require('../src/worker.cjs');

test('jsonSchema becomes --json-schema before the prompt', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  for (const jsonSchema of [schema, JSON.stringify(schema)]) {
    const args = workerArgs({ prompt: 'p', jsonSchema });
    assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), schema);
    assert.deepEqual(args.slice(-2), ['--', 'p']);
  }
  assert.ok(!workerArgs({ prompt: 'p' }).includes('--json-schema'));
});

test('only default, acceptEdits and dontAsk are permission modes', () => {
  for (const permissionMode of ['default', 'acceptEdits', 'dontAsk']) {
    const args = workerArgs({ prompt: 'p', permissionMode });
    assert.equal(args[args.indexOf('--permission-mode') + 1], permissionMode);
  }
  for (const permissionMode of ['bypassPermissions', 'plan', 'auto', '', null, ['default']]) {
    assert.throws(() => workerArgs({ prompt: 'p', permissionMode }), /permissionMode/);
  }
  assert.ok(!workerArgs({ prompt: 'p' }).includes('--permission-mode'));
});

test('env overrides are applied after workerEnv and null deletes', () => {
  const env = workerEnv({ PATH: '/bin', JAVA_HOME: '/j' }, '/dz');
  const out = applyEnv(env, { GH_CONFIG_DIR: '/empty', JAVA_HOME: null });
  assert.equal(out.GH_CONFIG_DIR, '/empty');
  assert.ok(!('JAVA_HOME' in out));
  assert.equal(out.PATH, '/bin');
  assert.equal(env.JAVA_HOME, '/j');
  assert.deepEqual(applyEnv(env), env);
  assert.throws(() => applyEnv(env, { A: 1 }), /A/);
});

test('protected variables can neither be changed, removed nor brought back', () => {
  const env = workerEnv({ PATH: '/bin' }, '/dz');
  const overrides = {
    CLAUDE_CONFIG_DIR: null, BUG_FIX_STATE_DIR: '/x', LEARN_APP_BUILD_SLOTS: '9', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1',
    GH_TOKEN: 't', GITHUB_TOKEN: 't', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'k', CLAUDECODE: '1',
    DISCORD_TOKEN: 't', LEARN_APP_DISCORD_WEBHOOK: 'w', CLAUDE_CODE_OAUTH_TOKEN: 't',
  };
  assert.deepEqual(applyEnv(env, overrides), env);
  const shared = workerEnv({ PATH: '/bin', DZ_CLAUDE_CONFIG: 'shared' }, '/dz');
  assert.ok(!('CLAUDE_CONFIG_DIR' in applyEnv(shared, { CLAUDE_CONFIG_DIR: '/x' })));
});
