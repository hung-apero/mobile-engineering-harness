const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { doctor } = require('../src/doctor.cjs');
const { makeHome } = require('./service-fixtures.cjs');

const ok = stdout => ({ ok: true, stdout });
function exec(overrides = {}) {
  const outputs = {
    claude: args => ok(args[0] === '--version' ? '2.1.332' : '{"loggedIn": true}'),
    gh: () => ok(''), adb: () => ok('List of devices attached\nS\tdevice\n'), pmset: () => ok(' sleep 0\n autorestart 1'),
    maestro: () => ok('1.40.0'), git: () => ok(''), ...overrides,
  };
  return (command, args, env) => outputs[path.basename(command)](args, env);
}

function setup(t, extra) {
  const h = makeHome(t);
  h.env.DZ_CLAUDE_BIN = 'claude';
  fs.mkdirSync(path.join(h.dzHome, 'claude'));
  return { h, run: overrides => doctor({ env: { ...h.env, ...extra }, exec: exec(overrides), home: h.root, codeDir: h.root }) };
}

const find = (checks, name) => checks.find(c => c.name === name);

test('doctor reports the desk as not used while no project declares a channel', t => {
  const { run } = setup(t);
  assert.equal(find(run(), 'desk').level, 'ĐẠT');
});

test('doctor includes the desk checks once a project declares a channel', t => {
  const { h, run } = setup(t);
  h.project('ABC1', { channel: '900000000000000002', roles: {} });
  const names = run().map(c => c.name);
  assert.ok(names.includes('tmux') && names.includes('token bot'), names.join(','));
});

test('doctor warns, never fails, for missing e2e inputs and names each one', t => {
  const { h, run } = setup(t);
  const missing = find(run({ maestro: () => ({ ok: false, missing: true, stdout: '' }) }), 'e2e');
  assert.equal(missing.level, 'CẢNH BÁO');
  assert.match(missing.detail, /android-test-harness/);
  assert.match(missing.detail, /maestro/);
  assert.match(missing.detail, /e2e\/ABC1\.json/);
  fs.mkdirSync(path.join(h.dzHome, 'android-test-harness'));
  fs.mkdirSync(path.join(h.dzHome, 'e2e'));
  fs.writeFileSync(path.join(h.dzHome, 'e2e', 'ABC1.json'), '{}');
  assert.equal(find(run(), 'e2e').level, 'ĐẠT');
});
