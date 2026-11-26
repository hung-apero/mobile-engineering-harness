const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setupBuild, g, step, stepsEvent, VERSION, REVIEW_OK } = require('./specs-build-fixtures.cjs');
const { withGh } = require('./specs-build-landing-fixtures.cjs');

const FEATURE = 'dz/feature-ABC1-1';
const remote = s => g(s.github, 'for-each-ref', '--format=%(refname:short)').split('\n');

async function toCandidate(s) {
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
}

test('live: pushes only the candidate, opens a draft PR and sends the install before asking the PO', async t => {
  const s = withGh(setupBuild(t, { live: true }));
  await toCandidate(s);
  await s.build();
  await s.state('po-trial');
  const { trial, candidate } = s.spec().data.build;
  assert.equal(g(s.github, 'rev-parse', `refs/heads/${FEATURE}`), candidate.sha);
  assert.deepEqual(remote(s), [FEATURE, 'main']);
  assert.equal(g(s.github, 'log', '--format=%H', FEATURE, '--', '.harness-run'), '');
  assert.deepEqual(s.prs.map(pr => [pr.head, pr.isDraft]), [[FEATURE, true]]);
  assert.equal(trial.pr, s.prs[0].url);
  assert.deepEqual(s.would(), []);
  assert.deepEqual(s.facade.review(s.id).trial.live, true);
});

test('live: a second candidate is a fast forward on the feature branch and reuses the PR', async t => {
  const s = withGh(setupBuild(t, { live: true }));
  await toCandidate(s);
  await s.build();
  await s.state('po-trial');
  const first = s.spec().data.build.candidate.sha;
  await s.facade.feedback(s.id, { text: 'Sửa màu' }, 'po', s.now);
  await s.code({ files: { 'feature.txt': '2\n' } });
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.build();
  await s.state('po-trial');
  const second = g(s.github, 'rev-parse', `refs/heads/${FEATURE}`);
  assert.equal(second, s.spec().data.build.candidate.sha);
  g(s.github, 'merge-base', '--is-ancestor', first, second);
  assert.equal(s.prs.length, 1);
});

test('live: the PR text follows each candidate, and a closed PR is opened again (M8)', async t => {
  const s = withGh(setupBuild(t, { live: true }));
  const bodies = [];
  const gh = s.ctx.bugs.gh;
  s.ctx.bugs.gh = async (args, options) => {
    if (args.includes('--body-file')) bodies.push([args[1], args[2], fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8')]);
    return gh(args, options);
  };
  await toCandidate(s);
  await s.build();
  await s.state('po-trial');
  const again = async (text, notes) => {
    await s.facade.feedback(s.id, { text }, 'po', s.now);
    await s.code({ files: { 'feature.txt': `${text}\n` } });
    await s.smoke();
    await s.review({ ...REVIEW_OK, findings: [{ file: 'feature.txt', line: 1, severity: 'minor', text: notes }] });
    await s.gate();
    await s.build();
    await s.build();
    await s.state('po-trial');
  };
  await again('Sửa màu', 'ghi chú hai');
  assert.deepEqual(bodies.map(item => item[0]), ['create', 'edit']);
  assert.equal(bodies[1][1], '1');
  assert.match(bodies[1][2], /ghi chú hai/);
  s.prs.length = 0;
  await again('Sửa chữ', 'ghi chú ba');
  assert.deepEqual(bodies.map(item => item[0]), ['create', 'edit', 'create']);
  assert.equal(s.spec().data.build.trial.pr, s.prs[0].url);
});

test('live: an install that could not be sent parks the spec and the PO is not asked', async t => {
  const s = withGh(setupBuild(t, { live: true }));
  await toCandidate(s);
  await s.finish(null, { kind: 'build', event: stepsEvent([step('verify'), step('assemble'), step('distribute', false)]) });
  await s.state('parked');
  assert.match(s.spec().data.parked.reason, /gửi bản cài không được/);
  assert.equal(s.waits().some(wait => wait.role === 'po'), false);
});

test('live: without commands.distribute no PO trial starts', async t => {
  const s = withGh(setupBuild(t, { live: true, commandsYaml: { distribute: undefined } }));
  await toCandidate(s);
  await s.state('parked');
  assert.match(s.spec().data.parked.reason, /chưa cấu hình commands.distribute/);
});

test('a project that goes live after the dry trial sends the same commit for real and asks the PO again', async t => {
  const s = withGh(setupBuild(t));
  await s.toBuilding();
  const sha = await s.toTrial();
  assert.deepEqual(remote(s), ['main']);
  s.h.project('ABC1', { live: true, commands: { compile: ['x'], unitTest: ['x'], assemble: ['x'], distribute: ['x'], apkGlob: 'out/*.apk' } });
  await s.tick();
  assert.equal((await s.approveTrial(sha).catch(error => ({ ok: false, error }))).ok, false);
  await s.gate();
  await s.build();
  await s.build();
  await s.state('po-trial');
  assert.equal(g(s.github, 'rev-parse', `refs/heads/${FEATURE}`), sha);
  assert.deepEqual(await s.approveTrial(sha), { ok: true });
  await s.gate();
  await s.build();
  await s.build();
  await s.state('done');
  assert.equal(s.batches()[0].data.live, true);
  const branch = `dz/release-${VERSION}`;
  g(s.github, 'merge-base', '--is-ancestor', sha, branch);
  assert.deepEqual(remote(s), [FEATURE, branch, 'main']);
  assert.equal(g(s.github, 'rev-parse', branch), g(s.mirror, 'rev-parse', `refs/heads/${branch}`));
  assert.deepEqual(s.prs.map(pr => pr.head), [FEATURE, branch]);
});
