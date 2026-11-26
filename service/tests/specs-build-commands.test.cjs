const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/specs/store.cjs');
const { validSpec } = require('../src/spec-commands.cjs');
const { setupBuild, VERSION } = require('./specs-build-fixtures.cjs');

test('build needs an approved spec, a version and an open version', async t => {
  const s = setupBuild(t);
  for (const args of [['build'], ['build', '1'], ['build', '1', '--version', 'x y'], ['build', '1', '--version', '1.9.2', 'x'], ['prereq'], ['prereq', '1', '--pr'], ['prereq', '1', '--clear', '--pr', '3']]) assert.equal(validSpec(args), false, args.join(' '));
  for (const args of [['build', '1', '--version', '1.9.2'], ['prereq', '1'], ['prereq', '1', '--pr', '272', '--branch', 'a/b:c'], ['prereq', '1', '--clear']]) assert.equal(validSpec(args), true, args.join(' '));
  await assert.rejects(s.cmd('build', '1', '--version', VERSION), /chỉ bắt đầu code spec đã duyệt/);
  await s.toApproved();
  const lines = await s.cmd('build', '1', '--version', VERSION);
  assert.match(lines.join('\n'), /Gợi ý từ nội dung spec \(chưa áp dụng\):\n- dz spec prereq 1 --pr apero\/learn-app#272/);
  assert.deepEqual(s.spec().data.prerequisites ?? [], []);
  await assert.rejects(s.cmd('build', '1', '--version', VERSION), /chỉ bắt đầu code/);
});

test('a parked build shows its reason, and retry goes back to the state it came from', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  for (let i = 0; i < 2; i++) await s.finish();
  assert.equal(s.spec().state, 'parked');
  assert.ok(s.waits().some(wait => wait.role === 'dev'));
  assert.match((await s.cmd('show', '1')).join('\n'), /1\.9\.2/);
  await s.cmd('retry', '1');
  assert.equal(s.spec().state, 'building');
  await s.until(() => s.running('spec').length === 1);
});

test('the links of a building spec are the ones the PO can use now', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.toTrial();
  assert.match((await s.cmd('link', '1')).join('\n'), /\/review\//);
  assert.equal(store.getSpec(s.ctx.db, 1).state, 'po-trial');
});
