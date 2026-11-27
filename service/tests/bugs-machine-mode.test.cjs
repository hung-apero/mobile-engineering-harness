const test = require('node:test');
const assert = require('node:assert/strict');
const { g } = require('./bugs-git-fixtures.cjs');
const { setup, BRANCH, VERSION } = require('./bugs-machine-fixtures.cjs');
const { resetDry } = require('../src/bugs/reset-dry.cjs');
const store = require('../src/bugs/store.cjs');
const { resolveWait } = require('../src/pings.cjs');

const TWO = ['AAP1-1', 'AAP1-2'];
const openWaits = s => s.rows("SELECT id, role, subject FROM waits WHERE state = 'open' ORDER BY id");
const refusals = s => s.codes().filter(c => c === 'X08 live-refused').length;

async function dryDone(t) {
  const s = setup(t, { live: false, keys: TWO });
  const first = await s.open(['AAP1-1']);
  await s.until(first);
  s.base = s.ref('develop');
  return { s, first };
}

for (const phase of ['fixing', 'building', 'delivering']) {
  test(`going live while a dry batch is in ${phase} abandons it without any external write`, async t => {
    const s = setup(t, { live: false });
    const id = await s.open();
    await s.until(id, s.kindsOf(phase));
    s.setLive(true);
    await s.advance(id);
    assert.equal(s.batch(id).state, 'abandoned');
    assert.equal(s.ticket('AAP1-1').state, 'accepted');
    assert.deepEqual(s.writes(), []);
    assert.equal(s.ref(BRANCH), s.ref('develop'));
    assert.ok(s.codes().includes('X08 mode-changed'));
    assert.equal(s.rows("SELECT id FROM jobs WHERE state IN ('queued', 'starting', 'running', 'parked')").length, 0);
  });
}

test('going dry while a live batch delivers abandons it, keeps the pushed branch and writes nothing more', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('delivering'));
  const writes = s.writes().length;
  s.setLive(false);
  await s.advance(id);
  assert.equal(s.batch(id).state, 'abandoned');
  assert.equal(s.writes().length, writes);
  assert.equal(s.ref(BRANCH), s.ref(BRANCH, s.github));
  assert.deepEqual(s.rows("SELECT id FROM effects WHERE id LIKE 'dry:%'"), []);
});

test('a mode change in the middle of a live distribution asks a person to check Firebase', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('distributing'));
  s.setLive(false);
  await s.advance(id);
  assert.equal(s.waits('dev').filter(w => /Firebase/.test(w)).length, 1);
});

test('a live claim is refused once while the version has dry traces', async t => {
  const { s } = await dryDone(t);
  s.setLive(true);
  const id = await s.open(['AAP1-2']);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await s.advance(id), { changed: false, phase: 'open' });
    s.now += 20 * 60 * 1000;
  }
  assert.equal(s.batch(id).state, 'open');
  assert.deepEqual(s.writes(), []);
  assert.equal(refusals(s), 1);
  assert.equal(s.waits('dev').filter(w => /reset-dry/.test(w)).length, 1);
});

test('dry merges left on the mirror alone refuse a live claim', async t => {
  const { s } = await dryDone(t);
  s.db.exec("DELETE FROM effects WHERE id LIKE 'dry:%'");
  for (const wait of openWaits(s)) resolveWait(s.db, wait.id, s.now);
  s.setLive(true);
  const id = await s.open(['AAP1-2']);
  await s.advance(id);
  assert.equal(s.batch(id).state, 'open');
  assert.equal(refusals(s), 1);
});

test('an open dry wait alone refuses a live claim', async t => {
  const { s } = await dryDone(t);
  s.db.exec("DELETE FROM effects WHERE id LIKE 'dry:%'");
  g(s.mirror, 'update-ref', `refs/heads/${BRANCH}`, s.base);
  s.setLive(true);
  const id = await s.open(['AAP1-2']);
  await s.advance(id);
  assert.equal(s.batch(id).state, 'open');
  for (const wait of openWaits(s)) resolveWait(s.db, wait.id, s.now);
  await s.until(id);
  assert.equal(s.batch(id).state, 'done');
});

test('a live claim is not refused when GitHub deleted a branch we had pushed live', async t => {
  const s = setup(t, { keys: TWO });
  await s.until(await s.open(['AAP1-1']));
  g(s.github, 'update-ref', '-d', `refs/heads/${BRANCH}`);
  const id = await s.open(['AAP1-2']);
  await s.advance(id);
  assert.equal(s.batch(id).state, 'running');
});

test('resetDry clears the dry traces of the version so that a live batch can run', async t => {
  const { s } = await dryDone(t);
  s.setLive(true);
  const held = await s.open(['AAP1-2']);
  await s.advance(held);
  store.transitionBatch(s.db, held, 'open', 'abandoned', s.now);
  s.setLive(false);
  const result = await resetDry(s.ctx, s.project, VERSION);
  assert.equal(result.tickets, 1);
  assert.ok(result.effects > 0);
  assert.deepEqual(openWaits(s), []);
  assert.deepEqual(s.rows("SELECT id FROM effects WHERE id LIKE 'dry:%'"), []);
  assert.equal(s.ticket('AAP1-1'), null);
  assert.equal(s.ref(BRANCH), s.ref('develop'));
  s.setLive(true);
  const id = await s.open(['AAP1-1']);
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.fake.issues['AAP1-1'].status, 'Resolved');
});

test('resetDry puts the mirror back on the GitHub copy of the version branch', async t => {
  const s = setup(t, { keys: TWO });
  await s.until(await s.open(['AAP1-1']));
  const pushed = s.ref(BRANCH, s.github);
  s.setLive(false);
  await s.until(await s.open(['AAP1-2']));
  assert.notEqual(s.ref(BRANCH), pushed);
  await resetDry(s.ctx, s.project, VERSION);
  assert.equal(s.ref(BRANCH), pushed);
  assert.equal(s.ticket('AAP1-1').state, 'done');
  assert.equal(s.ticket('AAP1-2'), null);
});

test('a ticket claimed live stays ours through a dry run and its reset', async t => {
  const { planBatches } = require('../src/bugs/intake.cjs');
  const again = s => planBatches(s.db, 'AAP1', s.now, { max_bugs: 8, max_hours: 4 })[0].id;
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('fixing'));
  s.setLive(false);
  await s.advance(id);
  await s.until(again(s));
  assert.equal(s.ticket('AAP1-1').state, 'done');
  await resetDry(s.ctx, s.project, VERSION);
  assert.equal(s.ticket('AAP1-1').state, 'accepted');
  s.setLive(true);
  assert.equal((await s.until(again(s))).state, 'done');
  assert.equal(s.fake.issues['AAP1-1'].status, 'Resolved');
});

test('resetDry refuses a live project and a version with an open batch, and then changes nothing', async t => {
  const { s } = await dryDone(t);
  const tip = s.ref(BRANCH);
  s.setLive(true);
  await assert.rejects(resetDry(s.ctx, s.project, VERSION), /live/);
  s.setLive(false);
  await s.open(['AAP1-2']);
  await assert.rejects(resetDry(s.ctx, s.project, VERSION), /đợt/);
  assert.equal(s.ref(BRANCH), tip);
  assert.ok(s.rows("SELECT id FROM effects WHERE id LIKE 'dry:%'").length > 0);
});
