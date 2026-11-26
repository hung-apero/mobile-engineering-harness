const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bugs = require('../../src/bugs/store.cjs');
const hooks = require('../../src/specs/release-hooks.cjs');
const { resetDry } = require('../../src/bugs/reset-dry.cjs');
const { setupBuild, commit, coded, g, VERSION } = require('./specs-build-fixtures.cjs');
const { BRANCH, bugLane, tip, drain, toLanding } = require('./specs-landing-fixtures.cjs');

const loadProject = s => require('../../src/projects.cjs').loadProjects(s.ctx.projectsDir, { dzHome: s.ctx.dzHome }).projects.get('ABC1');

async function solve(s, text) {
  await s.finish(repo => {
    const [, order] = s.calls.at(-1).args.at(-1).match(/\.learn-app\/(inputs\/rework-\d+\.md)/);
    assert.match(fs.readFileSync(path.join(repo, '.learn-app', order), 'utf8'), new RegExp(`git fetch origin ${BRANCH}[^]*git merge FETCH_HEAD`));
    g(repo, 'fetch', '-q', s.mirror, BRANCH);
    const merge = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', 'FETCH_HEAD'], { cwd: repo });
    assert.notEqual(merge.status, 0);
    commit(repo, { 'app.txt': text }, 'merge');
    coded(repo, { files: { 'note.txt': 'x\n' } });
  });
}

test('a conflict solved on the version still lands when a bug batch came in after it (I1)', async t => {
  const s = await toLanding(t, { files: { 'app.txt': 'feature\n' } });
  bugLane(s, { 'app.txt': 'bug\n' });
  await drain(s, () => s.spec().state === 'building');
  const first = tip(s);
  await solve(s, 'bug\nfeature\n');
  bugLane(s, { 'other.txt': 'other\n' }, 2);
  await drain(s, () => s.batches().every(batch => batch.state === 'done'));
  assert.notEqual(tip(s), first);
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.state('po-trial');
  const { candidate } = s.spec().data.build;
  assert.equal(candidate.start, first);
  g(s.mirror, 'merge-base', '--is-ancestor', first, candidate.sha);
  await s.approveTrial(candidate.sha);
  await drain(s, () => s.spec().state === 'landed-dry');
  assert.equal(g(s.mirror, 'show', `${tip(s)}:app.txt`), 'bug\nfeature');
  assert.deepEqual(s.tree(tip(s)), ['.gitignore', 'app.txt', 'note.txt', 'other.txt']);
});

async function baseConflict(t) {
  const s = setupBuild(t);
  await s.toBuilding();
  const sha = await s.toTrial();
  bugLane(s, { 'app.txt': 'bug\n' });
  await drain(s, () => s.batches().every(batch => batch.state === 'done'));
  commit(s.dev, { 'app.txt': 'main\n' }, 'main moves');
  g(s.dev, 'push', '-q', 'origin', 'main');
  await s.approveTrial(sha);
  return Object.assign(s, { sha });
}

test('a conflict between the base and the version is not the feature: it waits for the dev and lands later (I10)', async t => {
  const s = await baseConflict(t);
  await drain(s, () => s.decisions('spec-base-conflict').length === 1);
  assert.equal(s.spec().state, 'landing');
  assert.deepEqual([s.decisions('spec-conflict').length, s.spec().data.build.conflicts ?? 0], [0, 0]);
  const before = s.batches().length;
  for (let i = 0; i < 4; i++) await s.tick(16 * 60000);
  assert.equal(s.batches().length, before);
  assert.equal(s.waits().filter(wait => /Nhánh gốc xung đột/.test(wait.subject)).length, 1);
  const clone = `${s.h.root}/solve`;
  g(s.h.root, 'clone', '-q', '-b', BRANCH, s.mirror, clone);
  g(clone, 'fetch', '-q', s.github, 'main');
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', 'FETCH_HEAD'], { cwd: clone });
  const solved = commit(clone, { 'app.txt': 'bug\nmain\n' }, 'solve');
  g(s.mirror, 'fetch', '-q', clone, `HEAD:refs/heads/${BRANCH}`);
  assert.equal(tip(s), solved);
  await s.tick(16 * 60000);
  await drain(s, () => s.spec().state === 'landed-dry');
  assert.deepEqual(s.tree(tip(s)), ['.gitignore', 'app.txt', 'feature.txt']);
  assert.equal(s.spec().data.build.candidate.sha, s.sha);
});

test('a landing that found commits of a human on the version takes them and tries again (M12)', async t => {
  const s = setupBuild(t, { live: true });
  s.ghReply = args => {
    if (args[1] === 'list') return JSON.stringify(s.prs.filter(pr => pr.head === args[args.indexOf('--head') + 1]));
    if (args[1] === 'create') s.prs.push({ number: s.prs.length + 1, url: `https://github.com/apero/learn-app/pull/${s.prs.length + 1}`, isDraft: true, head: args[args.indexOf('--head') + 1] });
    return '[]';
  };
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.build();
  await s.state('po-trial');
  const { sha } = s.spec().data.build.trial;
  await s.approveTrial(sha);
  await s.until(() => s.running('gate').length === 1);
  const clone = `${s.h.root}/human`;
  g(s.h.root, 'clone', '-q', s.github, clone);
  const human = commit(clone, { 'human.txt': 'x\n' }, 'human');
  g(clone, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  await drain(s, () => s.spec().state === 'done');
  g(s.github, 'merge-base', '--is-ancestor', human, BRANCH);
  g(s.github, 'merge-base', '--is-ancestor', sha, BRANCH);
  assert.equal(s.decisions('spec-landing-again').length, 1);
  assert.match(s.ghCalls.find(args => args[1] === 'create' && args.includes(BRANCH)).join(' '), /--body-file/);
});

test('the version PR names the feature that landed (M13)', async t => {
  const { prText } = require('../../src/bugs/phase-build.cjs');
  const s = await toLanding(t);
  await drain(s, () => s.spec().state === 'landed-dry');
  const { body } = prText({ batch: s.batches()[0] });
  assert.match(body, new RegExp(`Spec gốc \\(#${s.id}\\): fix/spec-1-1 \\(${s.sha.slice(0, 12)}\\)`));
});

test('a dry landing ends in landed-dry, and reset-dry brings the spec back to the PO trial (I9)', async t => {
  const s = await toLanding(t);
  await drain(s, () => s.spec().state === 'landed-dry');
  assert.equal(hooks.featuresPending(s.ctx.db, { key: 'ABC1' }, { version: VERSION }), false);
  assert.equal(hooks.approvedSpec(s.ctx, { key: 'ABC1', live: true }), null);
  const before = g(s.mirror, 'rev-parse', 'refs/heads/main');
  await resetDry(s.ctx, loadProject(s), '9.9.9');
  assert.equal(s.spec().state, 'landed-dry');
  await resetDry(s.ctx, loadProject(s), VERSION);
  assert.equal(tip(s), before);
  assert.equal(s.spec().state, 'po-trial');
  assert.equal(s.spec().data.build.trial.approved, undefined);
  assert.equal(hooks.featuresPending(s.ctx.db, { key: 'ABC1' }, { version: VERSION }), true);
  assert.equal(hooks.approvedSpec(s.ctx, { key: 'ABC1' }), null);
  await s.tick();
  assert.equal(s.spec().state, 'po-trial');
  s.h.project('ABC1', { live: true, commands: { compile: ['x'], unitTest: ['x'], assemble: ['x'], distribute: ['x'], apkGlob: 'out/*.apk' } });
  s.ghReply = args => (args[1] === 'list' ? JSON.stringify(s.prs) : (args[1] === 'create' && s.prs.push({ number: 1, url: 'https://github.com/apero/learn-app/pull/1', isDraft: true, head: 'x' }), '[]'));
  await s.state('candidate');
  await s.gate();
  await s.build();
  await s.build();
  await s.state('po-trial');
  assert.deepEqual(await s.approveTrial(s.sha), { ok: true });
  await drain(s, () => s.spec().state === 'done');
  g(s.github, 'merge-base', '--is-ancestor', s.sha, BRANCH);
  assert.equal(bugs.listBatches(s.ctx.db, { project: 'ABC1' }).at(-1).data.live, true);
});
