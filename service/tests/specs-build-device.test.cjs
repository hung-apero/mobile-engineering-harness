const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { screensOf } = require('../src/specs/phase-uidiff.cjs');
const { setupBuild, put, g, SERIAL } = require('./specs-build-fixtures.cjs');

test('after build the spec holds a device, installs and opens the app, then frees it', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  assert.equal(s.spec().state, 'smoking');
  await s.until(() => s.running('build').length === 1, 'việc chạy thử');
  const [job] = s.running('build');
  assert.equal(s.devices.held.get(SERIAL), `spec:${s.id}:run`);
  assert.deepEqual(job.payload.smoke, { specId: s.id, serial: SERIAL, holder: `spec:${s.id}:run` });
  assert.equal(job.payload.worktree, s.repo());
  assert.equal(job.payload.sha, g(s.repo(), 'rev-parse', 'HEAD'));
  assert.equal(job.payload.distribute, undefined);
  await s.smoke();
  assert.equal(s.devices.held.size, 0);
  await s.until(() => s.spec().state === 'reviewing', 'reviewing');
  assert.equal(s.decisions('spec-smoke-passed').length, 1);
});

test('a red smoke sends the build back with the failing step', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  await s.smoke(false);
  assert.equal(s.spec().state, 'building');
  assert.equal(s.devices.held.size, 0);
  await s.until(() => s.running('spec').length === 1, 'build lại');
  const text = fs.readFileSync(path.join(s.repo(), '.harness-run/inputs/rework-1.md'), 'utf8');
  assert.match(text, /Chạy thử đỏ: smoke/);
  assert.equal(s.spec().data.build.fixes, 1);
  await s.code({ files: { 'feature.txt': 'fixed\n' } });
  await s.smoke(true, { assemble: false });
  assert.equal(s.spec().state, 'building');
  assert.match(fs.readFileSync(path.join(s.repo(), '.harness-run/inputs/rework-2.md'), 'utf8'), /Chạy thử đỏ: assemble/);
});

test('no free device waits for the dev without running anything', async t => {
  const s = setupBuild(t);
  s.devices.free = [];
  await s.toBuilding();
  await s.code();
  await s.tick();
  await s.tick();
  assert.equal(s.spec().state, 'smoking');
  assert.equal(s.running('build').length, 0);
  assert.ok(s.waits().some(wait => wait.role === 'dev' && /thiếu thiết bị/.test(wait.subject)));
  s.devices.free = [SERIAL];
  await s.tick(3 * 60 * 1000);
  await s.until(() => s.running('build').length === 1, 'có máy');
});

test('ui diff screens come from the harness figma digests, screens only', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  put(s.repo(), {
    'figma/man-hoc.json': { slug: 'man-hoc', node: '12:34', name: 'Màn học', kind: 'screen' },
    'figma/popup-thuong.json': { slug: 'popup-thuong', node: '12:40', name: 'Popup thưởng', kind: 'popup', parent: 'man-hoc' },
    'figma/Bad Slug.json': { slug: 'x', kind: 'screen' },
  });
  assert.deepEqual(screensOf(s.repo()), [{ slug: 'man-hoc', name: 'Màn học', node: '12:34' }]);
});
