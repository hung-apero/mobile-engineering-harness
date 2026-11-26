const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../vendor/learn-app/lib/learn-app-state.cjs');
const { setupBuild, editState, smoked } = require('./specs-build-fixtures.cjs');

const decision = (extra = {}) => ({ id: 'd1', question: 'Nút đóng ở đâu?', kind: 'business', options: [{ label: 'Trái', owner: 'x' }, { label: 'Phải', owner: 'x' }], choice: 'Trái', provisional: true, why: 'khớp spec nhất', ...extra });
const feature = (...decisions) => ({ id: 'path', source: 'app', status: 'done', files: [], gaps: [], decisions });
const choiceOf = s => S.readState(s.repo()).features[0].decisions[0];

async function asked(t, item = decision()) {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code({ features: [feature(item)] });
  return s;
}

const open = s => s.facade.quiz(s.id).ask.filter(q => !q.answered).map(q => q.id);
const setDecision = (repo, change) => editState(repo, state => {
  state.features[0].decisions = change(state.features[0].decisions[0]);
});

test('an asked question cannot be taken away: a decision settled without the PO parks the spec and stays asked (I6)', async t => {
  for (const forged of [{ provisional: false, auto: true }, { provisional: false, auto: false }, { choice: 'Phải', provisional: false, auto: true }]) {
    const s = await asked(t);
    await s.finish(repo => {
      smoked(repo);
      setDecision(repo, d => [{ ...d, ...forged }]);
    });
    assert.equal(s.spec().state, 'parked');
    assert.match(s.spec().data.parked.reason, /path\/d1/);
    assert.deepEqual(open(s), ['T1']);
    assert.equal(s.waits().filter(w => w.role === 'po').length, 1);
    s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
    assert.equal(s.facade.submit(s.id, 'po', s.now).ok, true);
    await s.cmd('retry', String(s.id));
    await s.until(() => s.running('spec').length === 1);
    assert.deepEqual([choiceOf(s).choice, choiceOf(s).provisional, choiceOf(s).auto], ['Trái', false, false]);
    assert.equal(s.spec().state, 'building');
    assert.match(s.calls.at(-1).args.at(-1), /rework-1\.md/);
    await s.code({ features: [feature(decision({ provisional: false }))] });
    await s.smoke();
    assert.equal(s.waits().filter(w => w.role === 'po').length, 0);
    assert.notEqual(s.spec().state, 'parked');
  }
});

test('a decision that disappears from the state stays asked, and its answer does not break the flow (I6)', async t => {
  const s = await asked(t);
  await s.finish(repo => {
    smoked(repo);
    setDecision(repo, () => []);
  });
  assert.deepEqual(open(s), ['T1']);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.until(() => s.spec().state === 'reviewing' && s.running('spec').length === 1);
  assert.equal(s.waits().length, 0);
});

test('a PO answer written by the worker for a question nobody asked is caught, an automatic UI choice is not (I6)', async t => {
  const forged = setupBuild(t);
  await forged.toBuilding();
  await forged.code({ features: [feature(decision({ provisional: false }))] });
  assert.equal(forged.spec().state, 'parked');
  assert.deepEqual(open(forged), ['T1']);
  const ui = setupBuild(t);
  await ui.toBuilding();
  await ui.code({ features: [feature(decision({ kind: 'ui', provisional: false, auto: true }))] });
  assert.equal(ui.spec().state, 'smoking');
});

test('an answer of the PO changed later by the worker is caught (I6)', async t => {
  const s = await asked(t);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.until(() => s.running('spec').length === 1);
  await s.smoke();
  await s.review();
  await s.gate();
  await s.build();
  await s.state('po-trial');
  await s.facade.feedback(s.id, { text: 'Sửa màu' }, 'po', s.now);
  await s.code({ features: [feature(decision({ choice: 'Phải', provisional: false }))] });
  assert.equal(s.spec().state, 'parked');
  assert.equal(open(s).length, 1);
});

test('an answer the worker puts back to its own first choice is asked again, not parked for ever (I6)', async t => {
  const s = await asked(t);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'B', text: '' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.smoke();
  await s.until(() => s.spec().state === 'building' && s.running('spec').length === 1);
  await s.code({ features: [feature(decision({ provisional: false }))] });
  assert.equal(s.spec().state, 'parked');
  const [qid] = open(s);
  s.facade.saveDraft(s.id, { qid, choice: 'B', text: '' }, 'po', s.now);
  assert.equal(s.facade.submit(s.id, 'po', s.now).ok, true);
  await s.cmd('retry', String(s.id));
  await s.until(() => s.running('spec').length === 1);
  assert.equal(choiceOf(s).choice, 'Phải');
});

test('an answer sent while the device is being given back is settled, not asked again (M1)', async t => {
  const s = await asked(t);
  const release = s.devices.releaseAll;
  let sent = false;
  s.devices.releaseAll = async options => {
    if (!sent && s.spec().state === 'smoking' && s.devices.held.size) {
      sent = true;
      s.facade.saveDraft(s.id, { qid: 'T1', choice: 'A', text: '' }, 'po', s.now);
      s.facade.submit(s.id, 'po', s.now);
    }
    return release(options);
  };
  await s.smoke();
  await s.until(() => s.spec().state === 'reviewing' && s.running('spec').length === 1);
  assert.equal(sent, true);
  assert.deepEqual([s.spec().round, open(s), choiceOf(s).provisional], [2, [], false]);
  assert.equal(s.waits().filter(w => w.role === 'po').length, 0);
});
