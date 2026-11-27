const test = require('node:test');
const assert = require('node:assert/strict');
const { g, commit } = require('./bugs-git-fixtures.cjs');
const { setup, BRANCH, VERSION } = require('./bugs-machine-fixtures.cjs');
const health = require('../src/health.cjs');
const store = require('../src/bugs/store.cjs');

const THREE = ['AAP1-1', 'AAP1-2', 'AAP1-3'];
const merged = s => s.files().filter(f => f.startsWith('AAP1-'));
const gates = s => s.jobKeys().filter(k => k.startsWith('gate')).length;
const states = (s, keys = THREE) => keys.map(key => s.ticket(key).state);
const lanesOf = (s, job) => merged(s).length && g(s.mirror, 'ls-tree', '--name-only', job.payload.sha).split('\n').filter(f => f.startsWith('AAP1-')).map(f => f.slice(0, 6));

function pushBase(s, files) {
  commit(s.dev, files);
  g(s.dev, 'push', '-q', 'origin', 'develop');
}

test('the base moving before the merge is pulled in', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'merging');
  pushBase(s, { 'base.txt': 'b\n' });
  await s.until(id);
  assert.ok(s.files().includes('base.txt'));
  assert.equal(s.ticket('AAP1-1').state, 'done');
});

test('the base moving while the merge runs leaves no half-merged branch', async t => {
  const s = setup(t);
  const id = await s.open();
  s.before['merge.mergeBatch'] = () => {
    if (!s.moved) pushBase(s, { 'AAP1-1.txt': 'khác\n' });
    s.moved = true;
  };
  await s.until(id);
  assert.equal(s.ticket('AAP1-1').state, 'done');
  assert.deepEqual(merged(s), ['AAP1-1.txt']);
});

test('a base conflict moves no ref, opens a dev wait and sends every key to the next batch', async t => {
  const s = setup(t, { keys: THREE });
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'merging');
  const start = g(s.mirror, 'rev-parse', BRANCH);
  g(s.dev, 'checkout', '-q', '-b', 'side', start);
  const side = commit(s.dev, { 'a.txt': 'version\n' });
  g(s.dev, 'push', '-q', s.mirror, `${side}:refs/heads/fix/side`);
  g(s.mirror, 'update-ref', `refs/heads/${BRANCH}`, side);
  g(s.dev, 'checkout', '-q', 'develop');
  pushBase(s, { 'a.txt': 'base\n' });
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.ref(BRANCH), side);
  assert.deepEqual(states(s), ['accepted', 'accepted', 'accepted']);
  assert.equal(s.waits('dev').length, 1);
  assert.ok(s.codes().includes('F04 base-conflict'));
});

test('a lane that conflicts goes to the next batch, the others land', async t => {
  const kinds = { ticket: (key, job) => s.approved(job.payload.batchId, key, { [`${key}.txt`]: 'x\n', ...(key !== 'AAP1-3' && { 'a.txt': `${key}\n` }) }) };
  const s = setup(t, { keys: THREE, kinds });
  await s.until(await s.open());
  assert.deepEqual(states(s), ['done', 'accepted', 'done']);
  assert.ok(s.codes('AAP1-2').includes('F04 next-batch'));
});

test('a lane moved after review is not merged and goes to dev', async t => {
  const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'] });
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'merging');
  const later = commit(s.repo(id), { 'sneaky.txt': 'x\n' });
  g(s.repo(id), 'push', '-q', '--force', 'origin', `${later}:refs/heads/fix/aap1-2-${id}`);
  await s.until(id);
  assert.equal(s.ticket('AAP1-2').state, 'dev');
  assert.equal(s.files().includes('sneaky.txt'), false);
});

test('a red gate bisects three lanes and only the culprit goes to the next batch', async t => {
  const s = setup(t, { keys: THREE, kinds: { gateOk: job => !lanesOf(s, job).includes('AAP1-2') } });
  const id = await s.open();
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(gates(s), 3);
  assert.deepEqual(states(s), ['done', 'accepted', 'done']);
  assert.deepEqual(merged(s), ['AAP1-1.txt', 'AAP1-3.txt']);
  assert.ok(s.codes('AAP1-2').includes('F01 next-batch'));
});

test('the bisect stops after four gate runs, resets the branch and sends every key to the next batch', async t => {
  const s = setup(t, { keys: ['AAP1-1', 'AAP1-2', 'AAP1-3', 'AAP1-4'], kinds: { gateOk: () => false } });
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'gating');
  const { before } = s.batch(id).data;
  await s.until(id);
  assert.equal(gates(s), 4);
  assert.equal(s.ref(BRANCH), before);
  assert.deepEqual(states(s), ['accepted', 'accepted', 'accepted']);
  assert.equal(s.calls.includes('merge.pushVersion'), false);
});

test('three always-red lanes use the four runs and land nothing', async t => {
  const s = setup(t, { keys: THREE, kinds: { gateOk: () => false } });
  await s.until(await s.open());
  assert.equal(gates(s), 4);
  assert.deepEqual(merged(s), []);
});

test('a red gate with one lane is not bisected', async t => {
  const s = setup(t, { kinds: { gateOk: () => false } });
  await s.until(await s.open());
  assert.equal(gates(s), 1);
  assert.equal(s.ticket('AAP1-1').state, 'accepted');
});

test('a gate that died is not a verdict: the batch is parked and the branch reset', async t => {
  const s = setup(t, { kinds: { gate: () => 'failed' } });
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'gating');
  const { before } = s.batch(id).data;
  assert.equal((await s.until(id)).state, 'abandoned');
  assert.equal(s.ref(BRANCH), before);
});

test('two batches of one version cannot both land', async t => {
  const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'], issues: { 'AAP1-1': { priority: 'Highest' } } });
  const first = await s.open();
  const second = store.listBatches(s.db, { project: 'AAP1' }).find(b => b.id !== first).id;
  await s.until(first, b => b.data.phase === 'gating');
  await s.until(second, b => b.data.phase === 'reviewing' && b.data.lanes.every(l => l.state === 'approved'));
  for (let i = 0; i < 3; i++) assert.deepEqual(await s.advance(second), { changed: false, phase: 'reviewing' });
  assert.equal((await s.until(first)).state, 'done');
  assert.equal((await s.until(second)).state, 'done');
  assert.deepEqual(merged(s), ['AAP1-1.txt', 'AAP1-2.txt']);
  assert.equal(s.prs.length, 1);
  assert.equal(s.ref(BRANCH, s.github), s.ref(BRANCH));
});

test('a red build resets the mirror ref, counts and sends the keys to the next batch', async t => {
  const s = setup(t, { kinds: { buildOk: () => false } });
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'building');
  const { before } = s.batch(id).data;
  await s.until(id);
  assert.equal(s.ref(BRANCH), before);
  assert.equal(store.getVersion(s.db, 'AAP1', VERSION).buildFailures, 1);
  assert.ok(s.codes().includes('Q02 build-red'));
  assert.equal(s.ticket('AAP1-1').state, 'accepted');
  assert.equal(s.fake.issues['AAP1-1'].status, 'In Progress');
  assert.equal(g(s.github, 'for-each-ref', '--format=%(refname)'), 'refs/heads/develop');
});

test('four red builds in a row pause the project, a green one starts the count again', async t => {
  const s = setup(t, { kinds: { buildOk: () => false } });
  const id = await s.open();
  s.db.prepare('UPDATE versions SET build_failures = 2').run();
  await s.until(id);
  assert.equal(health.isPaused(s.db, 'AAP1'), false);
  const again = await nextBatch(s);
  await s.until(again);
  assert.equal(health.isPaused(s.db, 'AAP1'), true);
  assert.ok(s.codes().includes('Q03 project-paused'));
  assert.equal(s.waits('dev').length, 1);
  health.setProjectState(s.db, 'AAP1', { paused: false });
  const ok = setup(t);
  const green = await ok.open();
  ok.db.prepare('UPDATE versions SET build_failures = 3').run();
  await ok.until(green);
  assert.equal(store.getVersion(ok.db, 'AAP1', VERSION).buildFailures, 0);
});

async function nextBatch(s) {
  const { planBatches } = require('../src/bugs/intake.cjs');
  return planBatches(s.db, 'AAP1', s.now, { max_bugs: 8, max_hours: 4 })[0].id;
}

test('a paused project gets no new job but a finished job is still used', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'fixing');
  await s.advance(id);
  health.setProjectState(s.db, 'AAP1', { paused: true });
  s.work();
  await s.advance(id);
  assert.equal(s.batch(id).data.phase, 'reviewing');
  assert.equal((await s.advance(id)).changed, false);
  assert.deepEqual(s.jobKeys(), [`bug ${id}#r1`]);
});

test('a large PR opens one merge wait per version', async t => {
  const kinds = { ticket: (key, job) => s.approved(job.payload.batchId, key, { [`${key}.txt`]: 'x\n'.repeat(300) }) };
  const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'], issues: { 'AAP1-1': { priority: 'Highest' } }, kinds });
  const first = await s.open();
  await s.until(first);
  assert.deepEqual(s.waits('dev'), []);
  await s.until(store.listBatches(s.db, { project: 'AAP1' })[1].id);
  assert.deepEqual(s.waits('dev'), [`Merge PR ${BRANCH} (quá 400 dòng)`]);
  assert.ok(s.codes().includes('F07 ping-merge'));
});
