const { test } = require('node:test');
const assert = require('node:assert/strict');
const files = require('../src/specs/repo-files.cjs');
const { changedSections } = require('../src/specs/change.cjs');
const { refreshBuilding } = require('../src/spec-build-commands.cjs');
const { setupBuild, coded, put, VERSION } = require('./specs-build-fixtures.cjs');

const NEW = '# [ABC1] Spec gốc\n\n## Path\nMàn path\n\n## Quiz\nMàn quiz phải có đồng hồ 30 giây, quiz-screen\n';
const source = (s, markdown = NEW) => refreshBuilding(s.ctx, s.spec(), { markdown, rawSha: 'a'.repeat(64) }, s.now);
const selfChange = repo => {
  coded(repo);
  put(repo, { 'clarified/spec-v3.md': '# Spec\nTrợ lý đổi luật\n' });
};

test('a spec that changes while coding is shown to the PO, holds the review, and goes on after approval', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const approvedBefore = s.spec().approvedSha;
  assert.match(source(s).join('\n'), /PO duyệt phần đổi \(Quiz\)/);
  await s.tick();
  assert.equal(s.running('spec').length, 1);
  const view = s.facade.review(s.id);
  assert.equal(view.spec.state, 'review');
  assert.match(view.markdown, /## Thay đổi của spec gốc[\s\S]*### Quiz\nMàn quiz phải có đồng hồ/);
  assert.doesNotMatch(view.markdown.split('## Thay đổi của spec gốc')[1], /Màn path/);
  assert.ok(s.waits().some(wait => wait.role === 'po' && /phần spec đổi/.test(wait.subject)));
  await s.code();
  await s.smoke();
  await s.tick();
  assert.equal(s.spec().state, 'reviewing');
  assert.equal(s.running('spec').length, 0);
  await assert.rejects(async () => s.facade.approve(s.id, { sha: approvedBefore, quote: 'Duyệt' }, 'po', s.now), { code: 'STALE' });
  assert.equal((await s.facade.approve(s.id, { sha: view.sha, quote: 'Duyệt phần đổi' }, 'po', s.now)).ok, true);
  await s.until(() => s.spec().state === 'building' && s.running('spec').length === 1, 'build lại');
  assert.equal(s.spec().approvedSha, view.sha);
  assert.equal(files.read(s.repo(), 'inputs/spec-v3.md'), view.markdown);
  await s.toTrial({ code: { files: { 'feature.txt': 'timer\n' } } });
});

test('feedback on the change makes a new text that needs its own approval', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  source(s);
  const before = s.facade.review(s.id).sha;
  assert.equal((await s.facade.feedback(s.id, { text: 'Đồng hồ 60 giây\n# Q1' }, 'po', s.now)).ok, true);
  const view = s.facade.review(s.id);
  assert.notEqual(view.sha, before);
  assert.match(view.markdown, /> Đồng hồ 60 giây\n> # Q1/);
  await assert.rejects(async () => s.facade.approve(s.id, { sha: before, quote: 'Duyệt' }, 'po', s.now), { code: 'STALE' });
});

test('a worker that rewrites the spec after the approval needs the PO, and the review waits', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.finish(selfChange);
  assert.equal(s.decisions('spec-changed-by-agent').length, 1);
  await s.smoke();
  await s.tick();
  assert.equal(s.spec().state, 'reviewing');
  assert.equal(s.running('spec').length, 0);
  const view = s.facade.review(s.id);
  assert.match(view.markdown, /Trợ lý đổi luật/);
  assert.ok(view.diff.some(line => line.type === 'add'));
  await s.facade.approve(s.id, { sha: view.sha, quote: 'Đồng ý' }, 'po', s.now);
  await s.review();
  assert.deepEqual([s.spec().state, s.spec().approvedSha], ['candidate', view.sha]);
});

test('a rewrite by the worker while a source change waits is kept in the text the PO approves', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  source(s);
  await s.finish(selfChange);
  const { markdown } = s.facade.review(s.id);
  assert.match(markdown, /Trợ lý đổi luật[\s\S]*## Thay đổi của spec gốc[\s\S]*đồng hồ 30 giây/);
});

test('dz spec refresh on a building spec asks for the change instead of starting over', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  s.ctx.db.prepare('UPDATE specs SET source = ? WHERE id = ?').run(JSON.stringify({ type: 'url', ref: '332470208' }), s.id);
  s.ctx.specs.confluence = () => ({ page: async () => ({ title: 'x', markdown: NEW }) });
  const lines = await s.cmd('refresh', String(s.id));
  assert.match(lines[0], /PO duyệt phần đổi \(Quiz\)/);
  assert.equal(s.spec().state, 'building');
  assert.equal(s.spec().data.build.version, VERSION);
  assert.equal(s.decisions('spec-changed-while-building').length, 1);
});

test('sections are compared by heading, with removed ones listed', () => {
  assert.deepEqual(changedSections('# A\nx\n## B\ny\n', '# A\nx\n## C\nz\n').map(item => [item.name, item.body === null]), [['C', false], ['B', true]]);
  assert.deepEqual(changedSections('# A\nx', '# A\nx'), []);
});
