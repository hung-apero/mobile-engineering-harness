const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const files = require('../src/specs/repo-files.cjs');
const { refreshBuilding } = require('../src/spec-build-commands.cjs');
const { sendBack } = require('../src/specs/build-kit.cjs');
const { createRun } = require('../src/specs/kit.cjs');
const { loadedProject } = require('../src/commands.cjs');
const { reworkLine } = require('../src/specs/rework.cjs');
const { setupBuild, put } = require('./specs-build-fixtures.cjs');

const CHANGED = '# [ABC1] Spec gốc\n\n## Path\nMàn path FIX-SPEC\n';
const inputOf = (repo, name) => fs.readFileSync(path.join(repo, '.harness-run', name), 'utf8');

function orders(s) {
  const repo = s.repo();
  const prompt = s.calls.at(-1).args.at(-1);
  const named = [...new Set([...prompt.matchAll(/\.harness-run\/(inputs\/rework-\d+\.md)/g)].map(match => match[1]))];
  assert.deepEqual(named, s.headless().rework ?? []);
  return named.map(name => inputOf(repo, name)).join('\n');
}

async function approveChange(s) {
  const lines = refreshBuilding(s.ctx, s.spec(), { markdown: CHANGED, rawSha: 'a'.repeat(64) }, s.now);
  const { sha } = s.facade.review(s.id);
  assert.equal((await s.facade.approve(s.id, { sha, quote: 'Duyệt' }, 'po', s.now)).ok, true);
  return { lines, sha };
}

test('an approved source change during build writes the next spec version and a rework', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const { lines, sha } = await approveChange(s);
  assert.doesNotMatch(lines.join('\n'), /Plan bị ảnh hưởng/);
  await s.finish(null);
  await s.until(() => s.spec().approvedSha === sha && s.running('spec').length === 1, 'build lại');
  const latest = files.latestSpec(s.repo());
  assert.deepEqual([latest.version, latest.sha], [3, sha]);
  assert.match(latest.markdown, /FIX-SPEC/);
  assert.ok(fs.existsSync(path.join(s.repo(), '.harness-run/inputs/spec-v3.md')));
  const text = orders(s);
  assert.match(text, /^# Yêu cầu làm lại 1$/m);
  assert.match(text, /inputs\/spec-v3\.md/);
  assert.doesNotMatch(text, /planner|Plan phải code lại/);
});

test('rework items clear after a good build and the files stay in inputs', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await approveChange(s);
  await s.finish(null);
  await s.until(() => s.headless().rework?.length === 1 && s.running('spec').length === 1, 'build lại');
  await s.code();
  assert.equal(s.spec().state, 'smoking');
  assert.deepEqual(s.spec().data.rework.items, []);
  assert.match(inputOf(s.repo(), 'inputs/rework-1.md'), /Yêu cầu làm lại 1/);
});

test('a worker that rewrites a rework file is parked, not trusted', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await approveChange(s);
  await s.finish(null);
  await s.until(() => s.headless().rework?.length === 1 && s.running('spec').length === 1, 'build lại');
  await s.finish(repo => put(repo, { 'inputs/rework-1.md': 'sửa bậy' }));
  assert.equal(s.spec().state, 'parked');
});

test('send back only writes a rework, never calls the state CLI, and keys stay unique', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const run = createRun(s.ctx, loadedProject(s.ctx, 'ABC1'), s.spec(), s.now);
  assert.equal(sendBack(run, 'Reviewer yêu cầu sửa: FIX-ONE', 'fix-1'), true);
  assert.equal(sendBack(run, 'lặp lại', 'fix-1'), true);
  assert.equal(sendBack(run, 'Cổng đỏ: FIX-TWO', 'fix-2'), true);
  const { items, n } = s.spec().data.rework;
  assert.equal(n, 2);
  assert.deepEqual(items.map(item => [item.n, item.key, Object.hasOwn(item, 'plans')]), [[1, 'fix-1', false], [2, 'fix-2', false]]);
  assert.deepEqual(reworkLine([{ file: 'inputs/rework-1.md' }]).length, 1);
  assert.throws(() => reworkLine([{ file: '../x.md' }]), /payload\.rework/);
});
