const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeHome, writeScript, DZ } = require('./service-fixtures.cjs');

test('dz install takes --shared-login and --allow-protected in any order and refuses anything else', t => {
  const h = makeHome(t);
  const bin = path.join(h.root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'git']) writeScript(path.join(bin, name), 'exit 0');
  const env = { HOME: h.root, DZ_HOME: path.join(h.root, 'dz'), PATH: `${bin}:/usr/bin:/bin` };
  const dz = (...args) => spawnSync(process.execPath, [DZ, ...args], { env, encoding: 'utf8' });
  const plist = path.join(h.root, 'Library', 'LaunchAgents', 'com.devzone.service.plist');
  for (const args of [['x'], ['--shared-login', '--shared-login'], ['--shared-login', 'x']]) assert.equal(dz('install', ...args).status, 2);
  assert.equal(dz('uninstall', '--allow-protected').status, 2);
  assert.equal(fs.existsSync(plist), false);
  const out = dz('install', '--allow-protected', '--shared-login');
  assert.equal(out.status, 0, out.stderr);
  assert.match(fs.readFileSync(plist, 'utf8'), /DZ_CLAUDE_CONFIG/);
  assert.ok(fs.readFileSync(plist, 'utf8').includes(`<string>${process.execPath}</string>`));
});
