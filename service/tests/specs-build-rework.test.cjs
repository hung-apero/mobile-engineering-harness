const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../vendor/learn-app/lib/learn-app-state.cjs');
const { refreshBuilding } = require('../src/spec-build-commands.cjs');
const { setupBuild, coded, editState, g, put, PLAN, REVIEW_OK } = require('./specs-build-fixtures.cjs');

const FEATURE = { id: 'path', source: 'app', status: 'done', files: [], gaps: [], decisions: [] };
const decision = { id: 'd1', question: 'Nút đóng ở đâu?', kind: 'business', options: [{ label: 'Trái', owner: 'x' }, { label: 'Phải', owner: 'x' }], choice: 'Trái', provisional: true, why: 'x' };
const inputOf = (repo, name) => fs.readFileSync(path.join(repo, '.learn-app', name), 'utf8');

function orders(s, repo) {
  const prompt = s.calls.at(-1).args.at(-1);
  const named = [...new Set([...prompt.matchAll(/\.learn-app\/(inputs\/rework-\d+\.md)/g)].map(match => match[1]))];
  assert.deepEqual(named, JSON.parse(inputOf(repo, 'inputs/headless.json')).rework ?? []);
  return named.map(name => inputOf(repo, name)).join('\n');
}

let pass = 0;
function worker(s, features = [FEATURE]) {
  return s.finish(repo => {
    pass += 1;
    coded(repo, { files: { 'feature.txt': `feature\n${orders(s, repo)}`, 'pass.txt': `${pass}\n` }, features });
  });
}

const built = s => g(s.mirror, 'show', `${s.spec().data.build.candidate.sha}:feature.txt`);

async function toCandidate(s, features) {
  await worker(s, features);
  await s.smoke();
}

async function again(s, want) {
  await s.state('building');
  assert.deepEqual(S.readState(s.repo()).features.map(f => [f.id, f.status]), [['path', 'todo']]);
  await worker(s);
  await s.smoke();
  await s.until(() => s.running('spec').length === 1, 'review');
  assert.match(built(s), want);
}

async function start(t, features) {
  const s = setupBuild(t);
  await s.toBuilding();
  await toCandidate(s, features);
  return s;
}

const changes = text => ({ ...REVIEW_OK, verdict: 'changes', findings: [{ file: 'feature.txt', line: 1, severity: 'major', text }] });

test('findings of the reviewer reach the worker, which only fixes what it is told', async t => {
  const s = await start(t);
  await s.review(changes('FIX-REVIEW thiếu màn kết quả'));
  await again(s, /FIX-REVIEW thiếu màn kết quả/);
  await s.review(changes('FIX-TWO'));
  await again(s, /FIX-TWO/);
  assert.doesNotMatch(built(s), /FIX-REVIEW/);
});

test('a red gate and a red build reach the worker', async t => {
  const gate = await start(t);
  await gate.review();
  await gate.gate(false);
  await again(gate, /Cổng đỏ:/);
  const build = await start(t);
  await build.review();
  await build.gate();
  await build.build(false);
  await again(build, /Build đỏ:/);
});

test('trial feedback of the PO reaches the worker word for word', async t => {
  const s = await start(t);
  await s.review();
  await s.gate();
  await s.build();
  await s.state('po-trial');
  const note = `FIX-PO nút sai màu\n${'x'.repeat(3000)}\nDòng cuối FIX-END`;
  assert.deepEqual(await s.facade.feedback(s.id, { text: note }, 'po', s.now), { ok: true });
  await again(s, /FIX-PO nút sai màu\n[^]*Dòng cuối FIX-END/);
});

test('a free answer to a provisional question reaches the worker', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await worker(s, [{ ...FEATURE, decisions: [decision] }]);
  s.facade.saveDraft(s.id, { qid: 'T1', choice: 'Khác', text: 'FIX-OTHER bỏ hẳn nút' }, 'po', s.now);
  s.facade.submit(s.id, 'po', s.now);
  await s.smoke();
  await again(s, /FIX-OTHER bỏ hẳn nút/);
});

test('an approved change of the spec reaches the worker', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await worker(s);
  refreshBuilding(s.ctx, s.spec(), { markdown: '# [ABC1] Spec gốc\n\n## Path\nMàn path FIX-SPEC\n', rawSha: 'a'.repeat(64) }, s.now);
  const { sha } = s.facade.review(s.id);
  assert.equal((await s.facade.approve(s.id, { sha, quote: 'Duyệt' }, 'po', s.now)).ok, true);
  await s.smoke();
  await again(s, /inputs\/spec-v3\.md/);
});

test('a worker that dies in the middle gets the same orders again, and they end when the code is done', async t => {
  const s = await start(t);
  await s.review(changes('FIX-REVIEW'));
  await s.state('building');
  await s.finish(repo => {
    assert.match(orders(s, repo), /FIX-REVIEW/);
    put(repo, { 'inputs/rework-1.md': 'sửa bậy' });
  });
  assert.equal(s.spec().state, 'building');
  await s.until(() => s.running('spec').length === 1);
  assert.match(orders(s, s.repo()), /FIX-REVIEW/);
  await worker(s);
  await s.until(() => s.running('spec').length === 1);
  assert.equal(s.spec().state, 'smoking');
  assert.equal(orders(s, s.repo()), '');
});

test('a change approved while the plans are still being made goes to planning with the change, not lost (M10)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  refreshBuilding(s.ctx, s.spec(), { markdown: '# [ABC1] Spec gốc\n\n## Path\nMàn path FIX-SPEC\n', rawSha: 'a'.repeat(64) }, s.now);
  const { sha } = s.facade.review(s.id);
  assert.equal((await s.facade.approve(s.id, { sha, quote: 'Duyệt' }, 'po', s.now)).ok, true);
  await s.finish(repo => {
    put(repo, { 'plans/01-path.md': PLAN('01-path') });
    editState(repo, state => {
      state.step = 'planning';
      state.plans = { '01-path': { status: 'merged', files: ['a'] } };
    });
  });
  await s.until(() => s.spec().approvedSha === sha && s.running('spec').length === 1);
  assert.match(orders(s, s.repo()), /inputs\/spec-v3\.md/);
  assert.match(orders(s, s.repo()), /planner/);
  const state = S.readState(s.repo());
  assert.deepEqual([state.step, state.plans['01-path'].status], ['planning', 'todo']);
});

test('the loop cap of learn-app does not stop the service from sending code back (I2)', async t => {
  const s = await start(t);
  editState(s.repo(), state => { state.loops = { 'handoff>coding': 3, 'smoke>coding': 2 }; });
  await s.review(changes('FIX-REVIEW'));
  await again(s, /FIX-REVIEW/);
  assert.deepEqual(S.readState(s.repo()).loops, { 'handoff>coding': 3, 'smoke>coding': 2 });
});
