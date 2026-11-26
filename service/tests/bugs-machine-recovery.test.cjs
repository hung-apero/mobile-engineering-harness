const test = require('node:test');
const assert = require('node:assert/strict');
const { g, commit } = require('./bugs-git-fixtures.cjs');
const { setup, BRANCH } = require('./bugs-machine-fixtures.cjs');
const health = require('../src/health.cjs');
const store = require('../src/bugs/store.cjs');
const { JiraError } = require('../src/bugs/jira.cjs');

const TWO = ['AAP1-1', 'AAP1-2'];
const merged = s => s.files().filter(f => f.startsWith('AAP1-'));

function refuse(s, name, key, text = `Issue ${key} not found (404)`) {
  s.before[name] = asked => {
    if (asked === key) throw new JiraError(text);
  };
}

async function twoBatches(t, kinds) {
  const s = setup(t, { keys: TWO, issues: { 'AAP1-1': { priority: 'Highest' } }, kinds });
  const first = await s.open();
  const second = store.listBatches(s.db, { project: 'AAP1' }).find(b => b.id !== first).id;
  return { s, first, second };
}

test('C1: a batch claimed while another lands starts from the last verified commit', async t => {
  const { s, first, second } = await twoBatches(t, { gateOk: job => job.payload.batchId !== s.red });
  s.red = first;
  await s.until(first, s.kindsOf('gating'));
  const { before, sha } = s.batch(first).data;
  assert.equal(s.ref(BRANCH), sha);
  await s.until(second, s.kindsOf('fixing'));
  assert.equal(s.batch(second).data.startSha, before);
  assert.equal(g(s.repo(second), 'rev-parse', 'HEAD'), before);
  assert.equal(g(s.repo(second), 'rev-parse', `refs/remotes/origin/${BRANCH}`), before);
  await s.until(first);
  assert.equal(s.ref(BRANCH), before);
  assert.equal((await s.until(second)).state, 'done');
  assert.equal(s.ticket('AAP1-2').state, 'done');
  assert.deepEqual(merged(s), ['AAP1-2.txt']);
});

test('C1: a batch whose start commit left the version branch goes to the next batch and frees landing', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('merging'));
  const lost = g(s.repo(id), 'commit-tree', '-m', 'x', 'HEAD^{tree}');
  g(s.repo(id), 'push', '-q', 'origin', `${lost}:refs/heads/fix/lost`);
  s.db.prepare('UPDATE batches SET data = ? WHERE id = ?').run(JSON.stringify({ ...s.batch(id).data, startSha: lost }), id);
  const tip = s.ref(BRANCH);
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.batch(id).data.landing, false);
  assert.equal(s.ticket('AAP1-1').state, 'accepted');
  assert.equal(s.ref(BRANCH), tip);
  assert.ok(s.codes('AAP1-1').includes('F04 next-batch'));
});

for (const [name, change] of [
  ['another person was assigned', issue => { issue.assignee = { displayName: 'Dev B' }; }],
  ['the ticket was closed', issue => { issue.status = 'Closed'; }],
  ['human-only was added', issue => { issue.labels = ['human-only']; }],
]) {
  test(`I1: a claim retried after a crash is dropped when ${name}`, async t => {
    const s = setup(t);
    const id = await s.open();
    s.boom = 'jira.transition';
    await s.advance(id);
    const writes = s.writes().length;
    change(s.fake.issues['AAP1-1']);
    s.now += 3 * 60 * 1000;
    assert.equal((await s.until(id)).state, 'done');
    assert.equal(s.ticket('AAP1-1').state, 'skipped');
    assert.equal(s.writes().length, writes);
  });
}

test('I2: a paused project or a closed intake claims no open batch', async t => {
  const s = setup(t);
  const id = await s.open();
  health.setProjectState(s.db, 'AAP1', { paused: true });
  assert.deepEqual(await s.advance(id), { changed: false, phase: 'open' });
  health.setProjectState(s.db, 'AAP1', { paused: false });
  s.freeGb = 1;
  assert.deepEqual(await s.advance(id), { changed: false, phase: 'open' });
  assert.equal(s.batch(id).state, 'open');
  s.freeGb = 500;
  await s.advance(id);
  assert.equal(s.batch(id).state, 'running');
});

test('I2: a paused project still pushes and delivers a finished build', async t => {
  const s = setup(t, { live: false });
  const id = await s.open();
  await s.until(id, s.kindsOf('publishing'));
  health.setProjectState(s.db, 'AAP1', { paused: true });
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.ticket('AAP1-1').state, 'done');
});

test('I6: a review that answers for a key of another lane is not a verdict', async t => {
  const kinds = { reviewLane: (l, job) => job.key.endsWith('v1') && l.keys[0] === 'AAP1-1' && { needsPo: [{ key: 'AAP1-2', question: 'q' }] } };
  const s = setup(t, { keys: TWO, kinds });
  const id = await s.open();
  await s.until(id);
  assert.deepEqual(s.jobKeys().filter(k => k.startsWith('review')), [`review ${id}#v1`, `review ${id}#v2`]);
  assert.deepEqual(TWO.map(key => s.ticket(key).state), ['done', 'done']);
});

test('I7: one ticket Jira refuses while claiming goes to dev, the others go on', async t => {
  const s = setup(t, { keys: TWO });
  const id = await s.open();
  refuse(s, 'jira.issue', 'AAP1-1');
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.ticket('AAP1-1').state, 'dev');
  assert.equal(s.waits('dev').filter(w => w.includes('AAP1-1')).length, 1);
  assert.equal(s.ticket('AAP1-2').state, 'done');
});

test('I7: one ticket Jira refuses while delivering goes to dev, the others go on', async t => {
  const s = setup(t, { keys: TWO });
  const id = await s.open();
  await s.until(id, s.kindsOf('delivering'));
  refuse(s, 'jira.comment', 'AAP1-1', '403 Client Error: Forbidden');
  assert.equal((await s.until(id)).state, 'done');
  assert.deepEqual(TWO.map(key => s.ticket(key).state), ['dev', 'done']);
  assert.equal(s.fake.issues['AAP1-1'].status, 'In Progress');
  assert.equal(s.fake.issues['AAP1-2'].status, 'Resolved');
});

test('I7: every ticket refused at once is an outage, not a verdict on the tickets', async t => {
  const s = setup(t, { keys: TWO });
  const id = await s.open();
  s.before['jira.issue'] = () => { throw new JiraError('403 Client Error: Forbidden'); };
  await s.advance(id);
  assert.deepEqual(TWO.map(key => s.ticket(key).state), ['batched', 'batched']);
  delete s.before['jira.issue'];
  assert.equal((await s.until(id)).state, 'done');
});

test('I7: a server error is never read as a refusal of the ticket', async t => {
  const s = setup(t, { keys: ['AAP1-404'] });
  const id = await s.open();
  refuse(s, 'jira.issue', 'AAP1-404', '503 Server Error for url /issue/AAP1-404');
  await s.advance(id);
  assert.equal(s.ticket('AAP1-404').state, 'batched');
});

test('I7: a branch that moved on GitHub is adopted without force and every key waits for the next batch', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('publishing'));
  const { before, sha } = s.batch(id).data;
  g(s.dev, 'fetch', '-q', s.mirror, before);
  g(s.dev, 'checkout', '-q', before);
  const theirs = commit(s.dev, { 'dev.txt': 'dev\n' });
  g(s.dev, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.ref(BRANCH, s.github), theirs);
  assert.equal(s.ref(BRANCH), theirs);
  assert.throws(() => g(s.github, 'cat-file', '-e', sha));
  assert.equal(s.ticket('AAP1-1').state, 'accepted');
  assert.equal(s.batch(id).data.landing, false);
  assert.ok(s.codes('AAP1-1').includes('F04 next-batch'));
  const { planBatches } = require('../src/bugs/intake.cjs');
  const again = planBatches(s.db, 'AAP1', s.now, { max_bugs: 8, max_hours: 4 })[0].id;
  assert.equal((await s.until(again)).state, 'done');
  assert.ok(s.files(s.github).includes('dev.txt'));
});

test('I7: a GitHub branch that dropped our commits leaves the mirror alone and asks dev', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('publishing'));
  const { before } = s.batch(id).data;
  g(s.dev, 'checkout', '-q', '--orphan', 'other');
  commit(s.dev, { 'x.txt': 'x\n' });
  g(s.dev, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
  assert.equal((await s.until(id)).state, 'done');
  assert.equal(s.ref(BRANCH), before);
  assert.equal(s.waits('dev').filter(w => w.includes(BRANCH)).length, 1);
});
