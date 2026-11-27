const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { g, commit, world } = require('./bugs-git-fixtures.cjs');
const { prepareSpecClone } = require('../src/specs/clone.cjs');
const files = require('../src/specs/repo-files.cjs');

const figma = 'https://www.figma.com/design/AbC123xyz/Demo';
const source = { type: 'url', ref: 'https://wiki.example/pages/9/x' };
const OVERLAY = 'harness_version: ">=0.1.0"\nproduct:\n  name: Demo\n';
const overlayFile = w => path.join(w.dzHome, 'projects', 'AAP1.overlay.yaml');
function ready(t) {
  const w = world(t);
  fs.mkdirSync(path.dirname(overlayFile(w)), { recursive: true });
  fs.writeFileSync(overlayFile(w), OVERLAY);
  return w;
}
const base = w => ({ dzHome: w.dzHome, project: w.project, githubUrl: w.github, specId: 'sp1', markdown: '# spec\r\nv1  \r\n', source, figma });
const run = (repo, name) => path.join(repo, '.harness-run', name);
const input = (repo, name) => run(repo, path.join('inputs', name));

test('the clone sits at workspaces/<KEY>/specs/<id>/repo on the base branch with inputs written', async t => {
  const w = ready(t);
  const { repo, harnessRoot } = await prepareSpecClone(base(w));
  assert.equal(repo, path.join(w.dzHome, 'workspaces', 'AAP1', 'specs', 'sp1', 'repo'));
  assert.equal(harnessRoot, repo);
  assert.equal(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
  assert.equal(g(repo, 'rev-parse', 'HEAD'), g(w.dev, 'rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(input(repo, 'spec-v1.md'), 'utf8'), '# spec\nv1\n');
  assert.deepEqual(fs.readdirSync(run(repo, 'inputs')), ['spec-v1.md']);
  assert.equal(g(repo, 'status', '--porcelain'), '');
});

test('the spec clone links harness skills and the feature agents, hidden from git', async t => {
  const w = ready(t);
  const { repo } = await prepareSpecClone(base(w));
  const claude = path.join(repo, '.claude');
  assert.equal(fs.readlinkSync(path.join(claude, 'skills', 'feature')), path.join(w.harness, 'skills', 'feature'));
  assert.equal(fs.readlinkSync(path.join(claude, 'skills', 'spec-clear')), path.join(w.harness, 'skills', 'spec-clear'));
  assert.deepEqual(fs.readdirSync(path.join(claude, 'agents')).sort(), ['architect.md', 'coder.md', 'qa.md', 'reviewer.md']);
  assert.equal(g(repo, 'status', '--porcelain'), '');
});

test('the project overlay is copied and upstream points at the pinned harness', async t => {
  const w = ready(t);
  const { repo } = await prepareSpecClone(base(w));
  assert.equal(fs.readFileSync(path.join(repo, '.harness-overlay', 'overlay.yaml'), 'utf8'), OVERLAY);
  assert.equal(fs.readlinkSync(path.join(repo, '.harness-overlay', 'upstream')), w.harness);
  fs.writeFileSync(overlayFile(w), `${OVERLAY}ui:\n  theme_class: DemoTheme\n`);
  await prepareSpecClone(base(w));
  assert.match(fs.readFileSync(path.join(repo, '.harness-overlay', 'overlay.yaml'), 'utf8'), /DemoTheme/);
});

test('a missing or symlinked overlay is refused with OVERLAY', async t => {
  const w = ready(t);
  fs.rmSync(overlayFile(w));
  await assert.rejects(prepareSpecClone(base(w)), { code: 'OVERLAY' });
  const elsewhere = path.join(w.root, 'other.yaml');
  fs.writeFileSync(elsewhere, OVERLAY);
  fs.symlinkSync(elsewhere, overlayFile(w));
  await assert.rejects(prepareSpecClone({ ...base(w), specId: 'sp9' }), { code: 'OVERLAY' });
});

test('no figma writes only the spec, figma travels in headless.json', async t => {
  const w = ready(t);
  const { repo } = await prepareSpecClone({ ...base(w), figma: null });
  assert.deepEqual(fs.readdirSync(run(repo, 'inputs')), ['spec-v1.md']);
});

test('a second run keeps the clone and its work, and a changed source is refused once a clarified spec exists', async t => {
  const w = ready(t);
  const first = await prepareSpecClone(base(w));
  fs.writeFileSync(path.join(first.repo, 'worker.txt'), 'wip');
  await prepareSpecClone({ ...base(w), markdown: '# spec\nv1 sửa\n' });
  assert.equal(fs.readFileSync(input(first.repo, 'spec-v1.md'), 'utf8'), '# spec\nv1 sửa\n');
  fs.mkdirSync(run(first.repo, 'clarified'));
  fs.writeFileSync(run(first.repo, 'clarified/spec-v2.md'), 'đã làm rõ');
  await prepareSpecClone({ ...base(w), markdown: '# spec\nv1 sửa\n' });
  assert.deepEqual(files.specVersions(first.repo), [1, 2]);
  assert.equal(fs.readFileSync(path.join(first.repo, 'worker.txt'), 'utf8'), 'wip');
  await assert.rejects(prepareSpecClone(base(w)), error => error.code === 'CHANGED');
  assert.equal(fs.readFileSync(run(first.repo, 'clarified/spec-v2.md'), 'utf8'), 'đã làm rõ');
  assert.equal(fs.readFileSync(path.join(first.repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter(line => line === '.harness-run/').length, 1);
});

test('a .harness-run already committed on the base branch is not carried into a new run', async t => {
  const w = ready(t);
  commit(w.dev, { '.harness-run/questions.md': 'cũ', '.harness-run/inputs/approval.json': '{}' });
  g(w.dev, 'push', '-q', 'origin', 'develop');
  const { repo } = await prepareSpecClone(base(w));
  assert.deepEqual(fs.readdirSync(run(repo, '')), ['inputs']);
  assert.deepEqual(fs.readdirSync(run(repo, 'inputs')), ['spec-v1.md']);
});

test('the clone is taken from the mirror, so a later base commit shows up only in a new spec clone', async t => {
  const w = ready(t);
  const first = await prepareSpecClone(base(w));
  const next = commit(w.dev, { 'a.txt': 'newer\n' });
  g(w.dev, 'push', '-q', 'origin', 'develop');
  const second = await prepareSpecClone({ ...base(w), specId: 'sp2' });
  assert.equal(g(second.repo, 'rev-parse', 'HEAD'), next);
  assert.notEqual(g(first.repo, 'rev-parse', 'HEAD'), next);
});

test('a bad specId, a bad figma link or a repointed origin is refused', async t => {
  const w = ready(t);
  for (const specId of ['', '../x', 'a/b', '-1', undefined]) await assert.rejects(prepareSpecClone({ ...base(w), specId }), /specId/);
  await assert.rejects(prepareSpecClone({ ...base(w), specId: 'sp3', figma: 'https://evil.example/design/K/x' }), /Figma/);
  const { repo } = await prepareSpecClone({ ...base(w), specId: 'sp4' });
  g(repo, 'remote', 'set-url', 'origin', '/elsewhere');
  await assert.rejects(prepareSpecClone({ ...base(w), specId: 'sp4' }), /origin/);
});

test('a pinned harness without the headless checker is refused with HARNESS', async t => {
  const w = ready(t);
  g(w.harness, 'rm', '-q', 'skills/feature/scripts/headless_check.py');
  g(w.harness, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'drop checker');
  const project = { ...w.project, harnessCommit: g(w.harness, 'rev-parse', 'HEAD') };
  await assert.rejects(prepareSpecClone({ ...base(w), project }), error => error.code === 'HARNESS' && /headless_check\.py/.test(error.message));
});

const APP = {
  'settings.gradle.kts': 'include(":app")\n',
  'gradle/libs.versions.toml': '[libraries]\nkoin = { module = "io.insert-koin:koin-android" }\nretrofit = { module = "com.squareup.retrofit2:retrofit" }\n',
  'app/build.gradle.kts': 'plugins { alias(libs.plugins.android.application) }\nandroid { namespace = "com.acme.learn" }\ndependencies { implementation("androidx.compose.ui:ui") }\n',
  'app/src/main/java/com/acme/learn/ui/Theme.kt': 'package com.acme.learn.ui\n\n@Composable\nfun AcmeLearnTheme(content: @Composable () -> Unit) = content()\n',
};
const appWorld = (t, files = APP) => {
  const w = world(t);
  commit(w.dev, files, 'app');
  g(w.dev, 'push', '-q', 'origin', 'develop');
  return w;
};

test('an overlay committed in the app repo is used as is and only upstream is linked', async t => {
  const w = appWorld(t, { ...APP, '.harness-overlay/overlay.yaml': OVERLAY });
  const { repo, overlayCreated } = await prepareSpecClone(base(w));
  assert.equal(overlayCreated, null);
  assert.equal(fs.readFileSync(path.join(repo, '.harness-overlay', 'overlay.yaml'), 'utf8'), OVERLAY);
  assert.equal(fs.readlinkSync(path.join(repo, '.harness-overlay', 'upstream')), w.harness);
  assert.equal(fs.existsSync(overlayFile(w)), false);
  assert.equal(g(repo, 'status', '--porcelain'), '');
});

test('without any overlay the service builds one from the app and keeps it for the project', async t => {
  const w = appWorld(t);
  const first = await prepareSpecClone(base(w));
  assert.deepEqual(first.overlayCreated, { file: overlayFile(w), product: 'AcmeLearn', ui: 'compose-android', di: 'koin' });
  const saved = fs.readFileSync(overlayFile(w), 'utf8');
  for (const line of ['  package: com.acme.learn', '  theme_class: AcmeLearnTheme', '  presenter: app', '  network: retrofit']) assert.ok(saved.split('\n').includes(line), line);
  assert.equal(fs.readFileSync(path.join(first.repo, '.harness-overlay', 'overlay.yaml'), 'utf8'), saved);
  assert.equal(g(first.repo, 'status', '--porcelain'), '');
  const second = await prepareSpecClone({ ...base(w), specId: 'sp2' });
  assert.equal(second.overlayCreated, null);
});

test('an app whose theme cannot be told waits for the dev with OVERLAY', async t => {
  const { 'app/src/main/java/com/acme/learn/ui/Theme.kt': theme, ...noTheme } = APP;
  for (const files of [noTheme, { ...APP, 'app/src/main/java/com/acme/learn/ui/Other.kt': 'fun OtherTheme() {}\n' }]) {
    const w = appWorld(t, files);
    await assert.rejects(prepareSpecClone(base(w)), error => error.code === 'OVERLAY' && /Theme/.test(error.message));
    assert.equal(fs.existsSync(overlayFile(w)), false);
  }
});
