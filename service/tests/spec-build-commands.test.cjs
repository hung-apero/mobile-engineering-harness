const { test } = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../src/spec-commands.cjs');
const { setupBuild, VERSION } = require('./specs-build-fixtures.cjs');

test('spec build starts an approved spec on v2', async t => {
  const s = setupBuild(t);
  await assert.rejects(commands.spec(s.ctx, ['build', String(s.id), '--version', VERSION], s.now), /chỉ bắt đầu code spec đã duyệt/);
  await s.toApproved();
  const lines = await commands.spec(s.ctx, ['build', String(s.id), '--version', VERSION], s.now);
  assert.match(lines.join('\n'), /chạy khô/);
  assert.equal(s.spec().state, 'waiting-prereq');
  await s.until(() => s.running('spec').length === 1, 'build');
  assert.equal(s.headless().segment, 'build');
});

test('build needs a valid version, only suggests prerequisites, and runs once', async t => {
  const s = setupBuild(t);
  for (const args of [['build'], ['build', '1'], ['build', '1', '--version', 'x y'], ['build', '1', '--version', '1.9.2', 'x'], ['prereq'], ['prereq', '1', '--pr'], ['prereq', '1', '--clear', '--pr', '3']]) assert.equal(commands.validSpec(args), false, args.join(' '));
  for (const args of [['build', '1', '--version', '1.9.2'], ['prereq', '1'], ['prereq', '1', '--pr', '272', '--branch', 'a/b:c'], ['prereq', '1', '--clear']]) assert.equal(commands.validSpec(args), true, args.join(' '));
  await s.toApproved();
  const lines = await s.cmd('build', String(s.id), '--version', VERSION);
  assert.match(lines.join('\n'), new RegExp(`Gợi ý từ nội dung spec \\(chưa áp dụng\\):\\n- dz spec prereq ${s.id} --pr apero/demo-app#272`));
  assert.deepEqual(s.spec().data.prerequisites ?? [], []);
  assert.equal(s.spec().data.build.version, VERSION);
  await assert.rejects(s.cmd('build', String(s.id), '--version', VERSION), /chỉ bắt đầu code/);
});

test('a parked build shows its reason, and retry goes back to the state it came from', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  for (let i = 0; i < 2; i++) await s.finish();
  assert.equal(s.spec().state, 'parked');
  assert.ok(s.waits().some(wait => wait.role === 'dev'));
  const shown = (await s.cmd('show', String(s.id))).join('\n');
  assert.match(shown, /Đang gác: đoạn build dừng giữa chừng 2 lần/);
  assert.match(shown, new RegExp(`Code cho bản ${VERSION.replaceAll('.', '\\.')}`));
  await s.cmd('retry', String(s.id));
  assert.equal(s.spec().state, 'building');
  await s.until(() => s.running('spec').length === 1, 'build lại');
});

test('the links of a building spec are the ones the PO can use now', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.toTrial();
  const links = await s.cmd('link', String(s.id));
  assert.equal(links.length, 1);
  assert.match(links[0], /\/review\//);
  assert.equal(s.spec().state, 'po-trial');
});
