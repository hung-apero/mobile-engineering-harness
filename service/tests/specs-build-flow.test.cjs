const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupBuild, coded, put, g } = require('./specs-build-fixtures.cjs');

test('build worker runs the harness headless with slots and branch in headless.json and no plugin dir', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const { env, args } = s.calls.at(-1);
  assert.equal(env.HARNESS_HEADLESS, '1');
  assert.deepEqual([env.LEARN_APP_HEADLESS, env.LEARN_APP_PARALLEL, env.LEARN_APP_TRACKING], [undefined, undefined, undefined]);
  assert.equal(args.includes('--plugin-dir'), false);
  const config = s.headless();
  assert.equal(config.segment, 'build');
  assert.equal(config.branch, `dz/spec-${s.id}`);
  assert.ok(Number.isInteger(config.slots) && config.slots >= 1);
  assert.equal(g(s.repo(), 'symbolic-ref', '--short', 'HEAD'), `dz/spec-${s.id}`);
  assert.equal(fs.readFileSync(path.join(s.repo(), 'local.properties'), 'utf8'), 'sdk.dir=/x\n');
});

test('build prompt names the build segment, the checker and the branch and forbids adb and push', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const { args } = s.calls.at(-1);
  const prompt = args.at(-1);
  assert.match(prompt, /HARNESS_HEADLESS=1/);
  assert.match(prompt, /đoạn build/);
  assert.match(prompt, /headless_check\.py build \./);
  assert.match(prompt, new RegExp(`dz/spec-${s.id}`));
  assert.doesNotMatch(prompt, /learn-app|state CLI|headless-start/);
  for (const rule of ['Bash(adb:*)', 'Bash(emulator:*)', 'Bash(git push:*)', 'Bash(gh:*)', 'AskUserQuestion']) assert.ok(args.includes(rule), rule);
});

test('a build that commits on the spec branch and writes result.json moves to smoking', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  assert.equal(s.spec().state, 'smoking');
  const [coded] = s.decisions('spec-coded');
  assert.deepEqual(coded.evidence.plans, ['Plan 01-path']);
});

test('result.json pointing at a missing commit reruns the build then parks after two tries', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const missing = 'a'.repeat(40);
  await s.code({ commit: missing, done: [] });
  assert.equal(s.spec().state, 'building');
  assert.ok(s.decisions('spec-segment-restarted').some(row => /commit không có trong repo/.test(row.evidence.reason)));
  await s.code({ commit: missing, done: [], files: { 'feature.txt': 'b\n' } });
  await s.state('parked');
  assert.match(s.spec().data.parked.reason, /commit không có trong repo/);
});

test('result.json on another branch or behind the branch tip reruns the build', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code({ branch: 'main' });
  assert.equal(s.spec().state, 'building');
  assert.ok(s.decisions('spec-segment-restarted').some(row => /nhánh main/.test(row.evidence.reason)));
  const old = g(s.repo(), 'rev-parse', 'HEAD');
  await s.code({ commit: old, files: { 'feature.txt': 'c\n' } });
  assert.equal(s.spec().state, 'building');
  assert.ok(s.decisions('spec-segment-restarted').some(row => /không phải đỉnh nhánh/.test(row.evidence.reason)));
});

test('blocked.json during build asks the dev or the PO', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.finish(repo => put(repo, { 'blocked.json': { segment: 'build', reason: 'thiếu quyền đọc repo SDK', missing: ['token GitHub'] } }));
  assert.equal(s.spec().state, 'needs-input');
  assert.equal(s.spec().data.needs.role, 'dev');
  assert.ok(s.waits().some(wait => wait.role === 'dev' && /thiếu quyền đọc repo SDK/.test(wait.subject)));
});

test('done plans in progress.json reset the rerun budget', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  for (const done of [[], ['01-a'], ['01-a', '02-b']]) {
    await s.finish(repo => put(repo, { 'progress.json': { plans: ['01-a', '02-b', '03-c'].map(id => ({ id, status: done.includes(id) ? 'done' : 'coding' })) } }));
    assert.equal(s.spec().state, 'building');
  }
  await s.code({ plans: ['01-a', '02-b', '03-c'] });
  assert.equal(s.spec().state, 'smoking');
});

test('a harness review that asks for changes reruns the build', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code({ verdict: 'changes', findings: [{ file: 'a.kt', line: 3, text: 'thiếu test' }] });
  assert.equal(s.spec().state, 'building');
  assert.ok(s.decisions('spec-segment-restarted').some(row => /review của harness/.test(row.evidence.reason)));
});

test('inputs changed during build park the spec', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.finish(repo => {
    coded(repo);
    put(repo, { 'inputs/approval.json': { sha: 'f'.repeat(64), by: 'worker', at: 1 } });
  });
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /inputs/);
});
