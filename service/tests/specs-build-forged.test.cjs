const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupBuild, REVIEW_OK } = require('./specs-build-fixtures.cjs');

const ASK = 'Nút đóng ở đâu?';
const open = s => s.facade.quiz(s.id).ask.filter(q => !q.answered).map(q => q.id);
const poWaits = s => s.waits().filter(w => w.role === 'po').length;
const answer = s => {
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  return s.facade.submit(s.id, 'po', s.now);
};

async function askedThenSentBack(t) {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  await s.smoke();
  await s.review({ ...REVIEW_OK, verdict: 'changes', needsPo: [ASK], findings: [{ file: 'feature.txt', line: 1, severity: 'major', text: 'thiếu nút' }] });
  await s.state('building');
  await s.code({ files: { 'feature.txt': 'v2\n' } });
  return s;
}

test('an asked question cannot be taken away: a later review without it keeps it asked and holds the trial approval (I6)', async t => {
  const s = await askedThenSentBack(t);
  await s.smoke();
  await s.review();
  assert.deepEqual(open(s), ['T1']);
  assert.equal(poWaits(s), 1);
  await s.gate();
  await s.build();
  await s.state('po-trial');
  const { sha } = s.facade.review(s.id);
  const refused = await s.approveTrial(sha);
  assert.deepEqual([refused.ok, /câu tạm chọn/.test(refused.error)], [false, true]);
  assert.equal(answer(s).ok, true);
  await s.tick();
  assert.deepEqual([open(s), s.waits().some(w => /tạm chọn/.test(w.subject)), s.spec().state], [[], false, 'po-trial']);
  assert.deepEqual(await s.approveTrial(sha), { ok: true });
});

test('an answer sent while the device is being given back is settled, not asked again (M1)', async t => {
  const s = await askedThenSentBack(t);
  const release = s.devices.releaseAll;
  let sent = false;
  s.devices.releaseAll = async options => {
    if (!sent && s.spec().state === 'smoking' && s.devices.held.size) {
      sent = true;
      answer(s);
    }
    return release(options);
  };
  await s.smoke();
  await s.until(() => s.spec().state === 'reviewing' && s.running('spec').length === 1, 'review');
  assert.equal(sent, true);
  assert.deepEqual([s.spec().round, open(s), Object.values(s.spec().data.prov.items)[0].status], [2, [], 'confirmed']);
  assert.equal(poWaits(s), 0);
});
