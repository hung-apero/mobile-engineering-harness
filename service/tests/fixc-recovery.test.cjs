const test = require('node:test');
const assert = require('node:assert/strict');
const { g, commit } = require('./bugs-git-fixtures.cjs');
const { setup, BRANCH, VERSION } = require('./bugs-machine-fixtures.cjs');
const { JiraError } = require('../src/bugs/jira.cjs');
const { resetDry } = require('../src/bugs/reset-dry.cjs');

const forbid = (s, ...names) => {
  for (const name of names) s.before[name] = () => { throw new JiraError('403 Client Error: Forbidden'); };
};
const lift = s => {
  for (const name of Object.keys(s.before)) delete s.before[name];
};
const devWaits = s => s.waits('dev').length;

test('N3: a single-key batch refused together with the control read is an outage', async t => {
  const s = setup(t);
  const id = await s.open();
  forbid(s, 'jira.issue', 'jira.search');
  await s.advance(id);
  assert.equal(s.ticket('AAP1-1').state, 'batched');
  assert.ok(s.codes().includes('X06 batch-error'));
  lift(s);
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.ticket('AAP1-1').state, 'done');
});

test('N3: a control read that shows no issue at all is an outage too', async t => {
  const s = setup(t);
  const id = await s.open();
  forbid(s, 'jira.issue');
  s.jira.search = async () => [];
  await s.advance(id);
  assert.equal(s.ticket('AAP1-1').state, 'batched');
});

for (const [verdict, after] of [['not-a-bug', 'concluded'], ['out-of-scope', 'dev']]) {
  test(`N3: a 403 outage while writing ${verdict} waits and never hands the tickets to dev`, async t => {
    const kinds = { ticket: key => ({ key, verdict, status: 'skipped', rootCause: 'x' }) };
    const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'], kinds });
    const id = await s.open();
    await s.until(id, s.kindsOf('fixing'));
    await s.advance(id);
    s.work();
    forbid(s, 'jira.comment', 'jira.search');
    await s.advance(id);
    assert.deepEqual(['AAP1-1', 'AAP1-2'].map(key => s.ticket(key).state), ['batched', 'batched']);
    assert.equal(devWaits(s), 0);
    assert.equal(s.codes().filter(c => c === 'X06 batch-error').length, 1);
    lift(s);
    await s.until(id);
    assert.deepEqual(['AAP1-1', 'AAP1-2'].map(key => s.ticket(key).state), [after, after]);
  });
}

test('N3: a single key refused while the project can be read goes to dev', async t => {
  const s = setup(t);
  const id = await s.open();
  forbid(s, 'jira.issue');
  await s.until(id);
  assert.equal(s.ticket('AAP1-1').state, 'dev');
  assert.equal(devWaits(s), 1);
});

function devPush(s, from) {
  g(s.dev, 'fetch', '-q', s.mirror, from);
  g(s.dev, 'checkout', '-q', 'FETCH_HEAD');
  const theirs = commit(s.dev, { 'dev.txt': 'dev\n' });
  g(s.dev, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  return theirs;
}

for (const boom of ['landing.resetVersion', 'landing.adoptRemote', 'landing.isPublished']) {
  test(`N4: a diverged push settles after a crash behind ${boom}`, async t => {
    const s = setup(t);
    const id = await s.open();
    await s.until(id, s.kindsOf('publishing'));
    const theirs = devPush(s, s.batch(id).data.before);
    s.boom = boom;
    await s.advance(id);
    assert.equal(s.batch(id).state, 'running');
    s.now += 3 * 60 * 1000;
    assert.equal((await s.until(id)).state, 'done');
    assert.equal(s.ref(BRANCH), theirs);
    assert.equal(s.ref(BRANCH, s.github), theirs);
    assert.equal(s.ticket('AAP1-1').state, 'accepted');
    assert.equal(s.codes().filter(c => c === 'X06 batch-error').length, 1);
    assert.equal(s.codes().filter(c => c === 'F04 branch-moved').length, 1);
  });
}

test('N4: a diverged branch that already holds our commit counts as pushed', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('publishing'));
  const theirs = devPush(s, s.batch(id).data.sha);
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.ticket('AAP1-1').state, 'done');
  assert.equal(s.ref(BRANCH, s.github), theirs);
  assert.equal(s.ref(BRANCH), theirs);
});

test('reset-dry deletes only the tickets of its own version', async t => {
  const s = setup(t, { live: false, keys: ['AAP1-1', 'AAP1-2'] });
  await s.until(await s.open());
  s.db.prepare("UPDATE tickets SET version = '1.9.3' WHERE key = 'AAP1-2'").run();
  const result = await resetDry(s.ctx, s.project, VERSION);
  assert.equal(result.tickets, 1);
  assert.equal(s.ticket('AAP1-1'), null);
  assert.equal(s.ticket('AAP1-2').state, 'done');
});

test('every reset-dry refusal names the whole order of steps', async t => {
  const order = /dz pause AAP1.*live: false.*dz batch park.*dz bugs reset-dry AAP1 1\.9\.2.*live: true.*dz resume AAP1/;
  const s = setup(t, { live: false, keys: ['AAP1-1', 'AAP1-2'] });
  await s.until(await s.open(['AAP1-1']));
  s.setLive(true);
  await assert.rejects(resetDry(s.ctx, s.project, VERSION), order);
  const held = await s.open(['AAP1-2']);
  await s.advance(held);
  assert.match(s.waits('dev').find(w => /chưa chạy live được/.test(w)), order);
  s.setLive(false);
  await assert.rejects(resetDry(s.ctx, s.project, VERSION), order);
});
