const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const bugs = require('../src/bugs/store.cjs');
const hooks = require('../src/specs/release-hooks.cjs');
const { setupBuild, g, VERSION } = require('./specs-build-fixtures.cjs');
const { bugLane, tip, inLanding, drain, toLanding, lastRework, solveConflict } = require('./specs-build-landing-fixtures.cjs');

test('a bug batch and a feature for the same version merge one after the other and keep both changes', async t => {
  const s = await toLanding(t);
  bugLane(s, { 'bug.txt': 'bug\n' });
  await s.until(() => s.batches().length === 2 && inLanding(s).length === 1, 'đang gộp');
  const first = inLanding(s)[0];
  const second = s.batches().find(batch => batch.id !== first.id);
  await s.tick();
  assert.equal(bugs.getBatch(s.ctx.db, second.id).data.phase, 'reviewing');
  await drain(s, () => s.spec().state === 'landed-dry' && s.batches().every(batch => batch.state === 'done'));
  assert.deepEqual(s.tree(tip(s)), ['.gitignore', 'app.txt', 'bug.txt', 'feature.txt']);
  for (const sha of [s.sha, 'refs/heads/fix/bug-1-1']) g(s.mirror, 'merge-base', '--is-ancestor', sha, tip(s));
});

test('a feature that conflicts with the version goes back once as a rework to merge it, and the PO approves the new commit', async t => {
  const s = await toLanding(t, { files: { 'app.txt': 'feature\n' } });
  bugLane(s, { 'app.txt': 'bug\n' });
  await drain(s, () => s.spec().state === 'building');
  assert.equal(s.decisions('spec-conflict').length, 1);
  await s.until(() => s.running('spec').length === 1, 'build lại');
  assert.match(lastRework(s), /git merge FETCH_HEAD/);
  await solveConflict(s, 'bug\nfeature\n');
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.state('po-trial');
  const { candidate } = s.spec().data.build;
  assert.equal(candidate.start, tip(s));
  await assert.rejects(s.approveTrial(s.sha), { code: 'STALE' });
  await s.approveTrial(candidate.sha);
  await drain(s, () => s.spec().state === 'landed-dry');
  assert.equal(g(s.mirror, 'show', `${tip(s)}:app.txt`), 'bug\nfeature');
});

test('a red gate on the version branch parks the spec and leaves the version as it was', async t => {
  const s = await toLanding(t);
  await s.until(() => s.running('gate').length === 1);
  const before = g(s.mirror, 'rev-parse', 'refs/heads/main');
  for (let i = 0; i < 10 && s.spec().state === 'landing'; i++) {
    if (s.running('gate').length) await s.gate(false);
    else await s.tick();
  }
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /không gộp được/);
  assert.equal(tip(s), before);
});

test('a version that closes before the landing parks the spec', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const sha = await s.toTrial();
  bugs.ensureVersion(s.ctx.db, { project: 'ABC1', version: VERSION, now: s.now });
  s.ctx.db.prepare("UPDATE versions SET state = 'closed' WHERE version = ?").run(VERSION);
  await s.approveTrial(sha);
  await s.state('parked');
  assert.match(s.spec().data.parked.reason, /đã đóng/);
  assert.equal(s.batches().length, 0);
});

test('a version waits for its features, and the approved spec is kept for the E2E after they land', async t => {
  const s = await toLanding(t);
  const project = { key: 'ABC1' };
  assert.equal(hooks.featuresPending(s.ctx.db, project, { version: VERSION }), true);
  assert.equal(hooks.featuresPending(s.ctx.db, project, { version: '9.9.9' }), false);
  assert.equal(hooks.approvedSpec(s.ctx, project), null);
  await drain(s, () => s.spec().state === 'landed-dry');
  assert.equal(hooks.featuresPending(s.ctx.db, project, { version: VERSION }), false);
  assert.match(fs.readFileSync(hooks.approvedSpec(s.ctx, project), 'utf8'), /\S/);
});
