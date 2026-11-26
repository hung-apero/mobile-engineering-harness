const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../src/specs/store.cjs');
const { setupBuild, put, g, VERSION, REVIEW_OK } = require('./specs-build-fixtures.cjs');

const BRIEF = '# Yêu cầu\n\n## Tóm tắt\nMàn path có nút học tiếp\n\n## Luật\n- Hiện streak\n';

test('a dry run goes from build to landed-dry with PR text from the brief and no state CLI', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  put(s.repo(), { 'brief/requirements.md': BRIEF });
  await s.code({ plans: ['01-path', '02-quiz'], findings: ['a.kt:3 đặt tên chưa rõ'] });
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.state('po-trial');
  const { candidate, trial } = s.spec().data.build;
  assert.equal(trial.sha, candidate.sha);
  assert.deepEqual(s.tree(candidate.sha), ['.gitignore', 'app.txt', 'feature.txt']);
  assert.ok(s.would().some(text => text.startsWith(`git push ${candidate.sha}:refs/heads/dz/feature-ABC1-1 `)));
  assert.ok(s.would().some(text => /gh pr create --draft dz\/feature-ABC1-1 -> main/.test(text)));
  assert.ok(s.would().includes(`firebase distribute ${candidate.sha}`));
  const [published] = s.decisions('spec-pr-text');
  assert.match(published.evidence.title, /^feat\(ABC1\): /);
  assert.match(published.evidence.body, /Plan 01-path/);
  assert.match(published.evidence.body, /Màn path có nút học tiếp/);
  assert.match(published.evidence.body, /đặt tên chưa rõ/);
  assert.match(published.evidence.body, new RegExp(`dz-spec-${s.id}`));
  assert.match(s.waits().find(wait => wait.role === 'po').link, /\/review\//);
  assert.deepEqual(await s.approveTrial(trial.sha), { ok: true });
  assert.equal(s.decisions('spec-trial-approved').length, 1);
  await s.gate();
  await s.build();
  await s.state('landed-dry');
  const tip = g(s.mirror, 'rev-parse', `refs/heads/dz/release-${VERSION}`);
  assert.deepEqual(s.tree(tip), ['.gitignore', 'app.txt', 'feature.txt']);
  assert.equal(g(s.github, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
  assert.equal(s.ghCalls.length, 0);
});

test('.harness-run never reaches the candidate tree, even when the worker commits it', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.finish(repo => {
    g(repo, 'add', '-f', '.harness-run/inputs/spec-v1.md');
    g(repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-qm', 'oops');
    const sha = g(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, '.harness-run', 'result.json'), JSON.stringify({ branch: `dz/spec-${s.id}`, commit: sha, plans: [], review: { verdict: 'approve', findings: [] } }));
  });
  await s.smoke();
  await s.review();
  await s.until(() => s.spec().data.build.candidate, 'candidate');
  const { sha } = s.spec().data.build.candidate;
  assert.equal(s.tree(sha).some(name => name.startsWith('.harness-run')), false);
});

test('the PO approval of an older candidate does not count for a newer one', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const first = await s.toTrial();
  assert.equal((await s.facade.feedback(s.id, { text: 'Nút sai màu ở màn path' }, 'po', s.now)).ok, true);
  assert.equal(s.spec().state, 'building');
  await assert.rejects(s.approveTrial(first), { code: 'STATE' });
  await s.code({ files: { 'feature.txt': 'feature 2\n' } });
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.state('po-trial');
  const { trial, candidate } = s.spec().data.build;
  assert.notEqual(trial.sha, first);
  assert.equal(candidate.n, 2);
  await assert.rejects(s.approveTrial(first), { code: 'STALE' });
  store.patchData(s.ctx.db, s.id, { build: { ...s.spec().data.build, trial: { ...trial, approved: { sha: first, quote: 'x', by: 'po', at: 1 } } } }, s.now);
  await s.tick();
  assert.equal(s.spec().state, 'po-trial');
  assert.equal(s.batches().length, 0);
  assert.deepEqual(await s.approveTrial(trial.sha), { ok: true });
  assert.equal(s.spec().state, 'landing');
});

test('a commit that is not the approved one is never landed', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const sha = await s.toTrial();
  await s.approveTrial(sha);
  g(s.mirror, 'update-ref', 'refs/heads/fix/spec-1-1', g(s.mirror, 'rev-parse', 'refs/heads/main'));
  await s.state('parked');
  assert.match(s.spec().data.parked.reason, /không gộp được vào bản/);
  assert.equal(g(s.mirror, 'rev-parse', `refs/heads/dz/release-${VERSION}`), g(s.mirror, 'rev-parse', 'refs/heads/main'));
});

test('reviewer findings, a red gate and PO trial notes reach the next build as rework files', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review({ ...REVIEW_OK, verdict: 'changes', findings: [{ file: 'feature.txt', line: 1, severity: 'major', text: 'FIX-REVIEW thiếu màn kết quả' }] });
  await s.state('building');
  await s.until(() => s.running('spec').length === 1, 'build lại');
  const read = n => fs.readFileSync(path.join(s.repo(), `.harness-run/inputs/rework-${n}.md`), 'utf8');
  assert.match(read(1), /FIX-REVIEW thiếu màn kết quả/);
  assert.match(s.calls.at(-1).args.at(-1), /\.harness-run\/inputs\/rework-1\.md/);
  await s.code({ files: { 'feature.txt': 'v2\n' } });
  await s.smoke();
  await s.review();
  await s.gate(false);
  await s.state('building');
  await s.until(() => s.running('spec').length === 1, 'build lại');
  assert.match(read(2), /Cổng đỏ:/);
  await s.code({ files: { 'feature.txt': 'v3\n' } });
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.state('po-trial');
  assert.deepEqual(await s.facade.feedback(s.id, { text: 'FIX-PO nút sai màu' }, 'po', s.now), { ok: true });
  await s.until(() => s.running('spec').length === 1, 'build lại');
  assert.match(read(3), /FIX-PO nút sai màu/);
  assert.match(read(3), /\.harness-run\/inputs\/po-notes-1\.md/);
});

test('a review question answered Other by the PO becomes a rework', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review({ ...REVIEW_OK, needsPo: ['Có hiện nút bỏ qua không?'] });
  await s.until(() => s.waits().some(wait => wait.role === 'po' && /tạm chọn/.test(wait.subject)), 'câu tạm');
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'Khác', text: 'FIX-OTHER bỏ hẳn nút' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.gate();
  await s.until(() => s.spec().state === 'building' && s.running('spec').length === 1, 'build lại');
  assert.match(fs.readFileSync(path.join(s.repo(), '.harness-run/inputs/rework-1.md'), 'utf8'), /FIX-OTHER bỏ hẳn nút/);
});
