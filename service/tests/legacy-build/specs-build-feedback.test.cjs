const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { refreshBuilding } = require('../../src/spec-build-commands.cjs');
const { setupBuild, coded, put } = require('./specs-build-fixtures.cjs');

const NEW = '# [ABC1] Spec gốc\n\n## Path\nMàn path\n\n## Quiz\nMàn quiz phải có đồng hồ 30 giây, quiz-screen\n';
const NEWER = NEW.replace('30 giây', '45 giây');
const source = (s, markdown = NEW) => refreshBuilding(s.ctx, s.spec(), { markdown, rawSha: 'a'.repeat(64) }, s.now);
const note = (s, name) => fs.readFileSync(path.join(s.repo(), '.learn-app', name), 'utf8');

function breakBack(s) {
  const real = s.ctx.specs.runState;
  const broken = { on: true };
  s.ctx.specs.runState = (project, repo, args, options) => (broken.on && args[0] === 'back' ? { code: 2, stdout: '', stderr: 'lỗi lệnh' } : real(project, repo, args, options));
  return broken;
}

test('trial feedback that could not be applied is kept, blocks the approval, and is applied after retry (I3)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const sha = await s.toTrial();
  const broken = breakBack(s);
  const out = await s.facade.feedback(s.id, { text: 'Nút sai màu' }, 'po', s.now);
  assert.equal(out.ok, false);
  assert.match(out.error, /Đã ghi góp ý/);
  assert.equal(s.spec().state, 'parked');
  await s.cmd('retry', String(s.id));
  assert.equal(s.spec().state, 'po-trial');
  const refused = await s.approveTrial(sha);
  assert.deepEqual([refused.ok, /góp ý/.test(refused.error)], [false, true]);
  const second = await s.facade.feedback(s.id, { text: 'Thêm: chữ nhỏ' }, 'po', s.now);
  assert.equal(second.ok, false);
  assert.deepEqual([note(s, 'inputs/po-notes-1.md'), note(s, 'inputs/po-notes-2.md')], ['Nút sai màu\n', 'Thêm: chữ nhỏ\n']);
  broken.on = false;
  await s.cmd('retry', String(s.id));
  await s.until(() => s.spec().state === 'building' && s.running('spec').length === 1);
  assert.match(note(s, 'inputs/rework-1.md'), /Nút sai màu[^]*Thêm: chữ nhỏ/);
  assert.deepEqual(s.spec().data.build.pendingNotes, []);
});

test('feedback of the PO on a change of the worker stays when the worker rewrites the spec again (I4)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.finish(repo => {
    coded(repo);
    put(repo, { 'inputs/spec-v3.md': '# Spec\nTrợ lý đổi luật\n' });
  });
  assert.equal((await s.facade.feedback(s.id, { text: 'Không đổi luật này\n# giả' }, 'po', s.now)).ok, true);
  await s.finish(repo => {
    put(repo, { 'inputs/spec-v4.md': '# Spec\nTrợ lý đổi lần hai\n' });
  });
  const { markdown } = s.facade.review(s.id);
  assert.match(markdown, /Trợ lý đổi lần hai[^]*Góp ý của PO[^]*> Không đổi luật này\n> # giả/);
});

test('refresh while feedback waits keeps the feedback beside the new change, and every feedback stays once (I4)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  source(s);
  await s.facade.feedback(s.id, { text: 'Đồng hồ phải to' }, 'po', s.now);
  await s.facade.feedback(s.id, { text: 'Có tiếng tích tắc' }, 'po', s.now);
  source(s, NEWER);
  const { markdown, sha } = s.facade.review(s.id);
  assert.match(markdown, /45 giây[^]*> Đồng hồ phải to[^]*> Có tiếng tích tắc/);
  assert.equal(markdown.match(/Đồng hồ phải to/g).length, 1);
  assert.doesNotMatch(markdown, /30 giây/);
  await s.finish(repo => {
    coded(repo);
    put(repo, { 'inputs/spec-v3.md': '# Spec\nTrợ lý đổi luật\n' });
  });
  const after = s.facade.review(s.id);
  assert.notEqual(after.sha, sha);
  assert.match(after.markdown, /Trợ lý đổi luật[^]*45 giây[^]*> Đồng hồ phải to[^]*> Có tiếng tích tắc/);
  assert.equal((await s.facade.approve(s.id, { sha: after.sha, quote: 'Duyệt' }, 'po', s.now)).ok, true);
  await s.smoke();
  await s.until(() => s.spec().state === 'building');
  assert.match(note(s, 'inputs/rework-1.md'), /Góp ý của PO[^]*Đồng hồ phải to[^]*Có tiếng tích tắc/);
  source(s, NEW);
  assert.doesNotMatch(s.facade.review(s.id).markdown.split('## Thay đổi của spec gốc').at(-1), /tích tắc/);
});
