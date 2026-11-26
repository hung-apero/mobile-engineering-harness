const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeHome } = require('./service-fixtures.cjs');

test('dz desk status, stop and setup work with no project and no service', t => {
  const h = makeHome(t);
  const status = h.dz('desk', 'status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Bàn điều phối: tắt/);
  assert.equal(h.dz('desk', 'stop').status, 0);
  const setup = h.dz('desk', 'setup');
  assert.equal(setup.status, 0, setup.stderr);
  assert.ok(setup.stdout.includes(h.dzHome));
});

test('dz desk start refuses while no enabled project declares a channel', t => {
  const h = makeHome(t);
  const out = h.dz('desk', 'start');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /Lỗi: chưa project nào/);
});

test('dz release status names a version that does not exist; bad arguments print the usage', t => {
  const h = makeHome(t);
  const missing = h.dz('release', 'status', 'ABC1', '1.0.0');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /chưa có version ABC1 1\.0\.0/);
  for (const args of [['release'], ['release', 'status', 'abc', '1.0.0'], ['release', 'defer', 'ABC1', '1.0.0', 'ABC1-1'], ['desk', 'x'], ['desk'], ['newapp'], ['newapp', 'start'], ['newapp', 'status', 'ABC9', '--name', 'x'], ['newapp', 'start', 'ABC9', '--name']]) {
    const out = h.dz(...args);
    assert.equal(out.status, 2, args.join(' '));
    assert.match(out.stderr, /release status <KEY> <version>.*newapp start\|status\|check\|create.*desk start\|stop\|status\|setup/s);
  }
});

test('dz newapp start lists what the dev must provide and status reads it back', t => {
  const h = makeHome(t);
  const start = h.dz('newapp', 'start', 'ABC9', '--name', 'App Chín', '--package', 'com.abc.nine');
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /Danh sách dev cần cung cấp/);
  assert.match(start.stdout, /repo-empty/);
  const status = h.dz('newapp', 'status', 'ABC9');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Kiểm lần cuối: chưa kiểm/);
  assert.match(h.dz('newapp', 'status', 'ABC8').stderr, /chưa có danh sách app mới ABC8/);
});

test('dz spec build and prereq are reachable and validated', t => {
  const h = makeHome(t);
  assert.equal(h.dz('spec', 'build', '1').status, 2);
  const out = h.dz('spec', 'build', '999', '--version', '1.0.0');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /999/);
  assert.equal(h.dz('spec', 'prereq', '999', '--clear').status, 1);
});
