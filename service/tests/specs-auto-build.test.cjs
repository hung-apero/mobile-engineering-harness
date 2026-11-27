const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupBuild, commit, g } = require('./specs-build-fixtures.cjs');
const { nextFeatureVersion, versionOfGradle } = require('../src/specs/auto-build.cjs');

function appVersion(s, files) {
  commit(s.dev, files, 'chore: version');
  g(s.dev, 'push', '-q', 'origin', 'main');
}

const started = s => s.spec().data.build?.version;

test('the next feature version is the next minor of the app, skipping closed versions', () => {
  assert.equal(nextFeatureVersion('1.9.2', () => false), '1.10.0');
  assert.equal(nextFeatureVersion('2.0.0', () => false), '2.1.0');
  assert.equal(nextFeatureVersion('1.9.2', version => ['1.10.0', '1.11.0'].includes(version)), '1.12.0');
});

test('the app version is read from build.gradle.kts or build.gradle', () => {
  assert.equal(versionOfGradle('android {\n}\nval appVersionName = "1.9.2"\n'), '1.9.2');
  assert.equal(versionOfGradle('defaultConfig {\n    versionName = "3.4.5"\n}'), '3.4.5');
  assert.equal(versionOfGradle("defaultConfig {\n    versionName '2.3.4'\n}"), '2.3.4');
  assert.equal(versionOfGradle('defaultConfig {\n    versionName = appVersionName\n}'), null);
  assert.equal(versionOfGradle(''), null);
});

test('an approved spec starts coding on its own for the next minor version of the app', async t => {
  const s = setupBuild(t);
  appVersion(s, { 'app/build.gradle.kts': 'val appVersionName = "1.9.2"\n' });
  await s.toApproved();
  await s.until(() => started(s), 'tự vào code');
  assert.equal(started(s), '1.10.0');
  assert.notEqual(s.spec().state, 'approved');
  const [decision] = s.decisions('spec-build');
  assert.deepEqual({ version: decision.evidence.version, auto: decision.evidence.auto, from: decision.evidence.from }, { version: '1.10.0', auto: true, from: '1.9.2' });
  await s.until(() => s.running('spec').length === 1, 'việc build');
});

test('a closed next version moves the spec to the one after', async t => {
  const s = setupBuild(t);
  appVersion(s, { 'app/build.gradle': "android {\n  defaultConfig {\n    versionName '1.9.2'\n  }\n}\n" });
  s.ctx.db.prepare("INSERT INTO versions (project, version, branch, state) VALUES ('ABC1', '1.10.0', 'dz/release-1.10.0', 'closed')").run();
  await s.toApproved();
  await s.until(() => started(s), 'tự vào code');
  assert.equal(started(s), '1.11.0');
});

test('without a readable app version the spec waits for the dev and dz spec build still works', async t => {
  const s = setupBuild(t);
  await s.toApproved();
  await s.until(() => s.waits().some(wait => wait.role === 'dev' && /dz spec build/.test(wait.subject)), 'chờ dev');
  assert.equal(s.spec().state, 'approved');
  s.startBuild();
  assert.equal(s.spec().state, 'waiting-prereq');
  assert.equal(s.waits().some(wait => /dz spec build/.test(wait.subject)), false);
});
