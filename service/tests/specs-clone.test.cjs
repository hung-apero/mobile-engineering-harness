const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { g, commit, world } = require('./bugs-git-fixtures.cjs');
const { prepareSpecClone } = require('../src/specs/clone.cjs');
const { validateSpecSource } = require('../vendor/learn-app/lib/spec-source.cjs');
const { specVersions } = require('../vendor/learn-app/lib/looper-parse.cjs');

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
const input = (repo, name) => path.join(repo, '.learn-app', 'inputs', name);

test('the clone sits at workspaces/<KEY>/specs/<id>/repo on the base branch with inputs written', async t => {
  const w = ready(t);
  const { repo, harnessRoot } = await prepareSpecClone(base(w));
  assert.equal(repo, path.join(w.dzHome, 'workspaces', 'AAP1', 'specs', 'sp1', 'repo'));
  assert.equal(harnessRoot, repo);
  assert.equal(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'develop');
  assert.equal(g(repo, 'rev-parse', 'HEAD'), g(w.dev, 'rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(input(repo, 'spec-v1.md'), 'utf8'), '# spec\nv1\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(input(repo, 'spec-source.json'), 'utf8')), source);
  assert.deepEqual(validateSpecSource(JSON.parse(fs.readFileSync(input(repo, 'spec-source.json'), 'utf8'))), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(input(repo, 'figma-url.json'), 'utf8')), { url: figma, fileKey: 'AbC123xyz' });
  assert.equal(fs.existsSync(input(repo, 'no-design')), false);
  assert.equal(g(repo, 'status', '--porcelain'), '?? .learn-app/');
});

test('the spec clone links harness skills and the feature agents, hidden from git', async t => {
  const w = ready(t);
  const { repo } = await prepareSpecClone(base(w));
  const claude = path.join(repo, '.claude');
  assert.equal(fs.readlinkSync(path.join(claude, 'skills', 'feature')), path.join(w.harness, 'skills', 'feature'));
  assert.equal(fs.readlinkSync(path.join(claude, 'skills', 'spec-clear')), path.join(w.harness, 'skills', 'spec-clear'));
  assert.deepEqual(fs.readdirSync(path.join(claude, 'agents')).sort(), ['architect.md', 'coder.md', 'qa.md', 'reviewer.md']);
  assert.equal(g(repo, 'status', '--porcelain'), '?? .learn-app/');
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

test('no figma writes inputs/no-design instead of a figma link', async t => {
  const w = ready(t);
  const { repo } = await prepareSpecClone({ ...base(w), figma: null });
  assert.equal(fs.existsSync(input(repo, 'no-design')), true);
  assert.equal(fs.existsSync(input(repo, 'figma-url.json')), false);
});

test('a second run keeps the clone and its work and never writes a second spec version', async t => {
  const w = ready(t);
  const first = await prepareSpecClone(base(w));
  fs.writeFileSync(path.join(first.repo, 'worker.txt'), 'wip');
  fs.mkdirSync(path.join(first.repo, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(first.repo, '.git', 'info', 'exclude'), '/.learn-app/\nx\n');
  fs.writeFileSync(input(first.repo, 'spec-v2.md'), 'đã làm rõ');
  await prepareSpecClone(base(w));
  assert.deepEqual(specVersions(first.repo), [1, 2]);
  assert.equal(fs.readFileSync(path.join(first.repo, 'worker.txt'), 'utf8'), 'wip');
  assert.doesNotMatch(fs.readFileSync(path.join(first.repo, '.git', 'info', 'exclude'), 'utf8'), /learn-app/);
  await prepareSpecClone({ ...base(w), markdown: '# spec\nv1 sửa\n' });
  assert.equal(fs.readFileSync(input(first.repo, 'spec-v1.md'), 'utf8'), '# spec\nv1 sửa\n');
  fs.writeFileSync(path.join(first.repo, '.learn-app', 'state.json'), '{}');
  await assert.rejects(prepareSpecClone(base(w)), error => error.code === 'CHANGED');
  assert.equal(fs.readFileSync(input(first.repo, 'spec-v2.md'), 'utf8'), 'đã làm rõ');
});

test('a .learn-app already committed on the base branch is not carried into a new run', async t => {
  const w = ready(t);
  commit(w.dev, { '.learn-app/state.json': '{"step":"handoff"}', '.learn-app/questions.md': 'cũ' });
  g(w.dev, 'push', '-q', 'origin', 'develop');
  const { repo } = await prepareSpecClone(base(w));
  assert.deepEqual(fs.readdirSync(path.join(repo, '.learn-app')), ['inputs']);
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
