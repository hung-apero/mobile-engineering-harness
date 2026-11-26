const test = require('node:test');
const assert = require('node:assert/strict');
const { g } = require('./bugs-git-fixtures.cjs');
const { setup, BRANCH } = require('./bugs-machine-fixtures.cjs');
const jobs = require('../src/jobs.cjs');

function assertOnce(s, id, commit) {
  const issue = s.fake.issues['AAP1-1'];
  assert.equal(issue.status, 'Resolved');
  assert.equal(issue.comments.length, 1);
  assert.deepEqual(issue.labels, []);
  assert.equal(s.fake.calls.filter(c => c.name === 'jira_transition_issue').length, 2);
  assert.equal(s.prs.length, 1);
  assert.equal(s.calls.filter(c => c === 'gh.create').length, 1);
  assert.deepEqual(s.jobKeys(), [`bug ${id}#r1`, `review ${id}#v1`, `gate ${id}#g1`, `build ${id}#b1`, `build ${id}#d1`]);
  const merges = g(s.mirror, 'rev-list', '--first-parent', '--merges', '--parents', BRANCH).split('\n').map(row => row.split(' ')[2]);
  assert.deepEqual(merges, [commit]);
  assert.equal(s.ref(BRANCH, s.github), s.ref(BRANCH));
  assert.equal(s.ticket('AAP1-1').state, 'done');
  assert.deepEqual(s.waits('qa').length, 1);
  assert.deepEqual(s.waits('dev'), []);
}

const POINTS = [
  'jira.issue', 'jira.transition', 'jira.addLabels', 'jira.transitions', 'workspace.ensureMirror', 'workspace.ensureVersionBranch', 'workspace.ensureClone',
  'landing.laneState', 'diffGuard.checkDiff', 'landing.versionTip', 'landing.versionWorktree', 'landing.changedFiles', 'merge.mergeBatch',
  'merge.pushVersion', 'merge.ensurePr', 'landing.diffLines', 'jira.comment', 'jira.removeLabels', 'cleanup.releaseDevices', 'cleanup.removeBatchFiles',
];

for (const point of POINTS) {
  test(`a crash right after ${point} does not repeat its effect`, async t => {
    const s = setup(t);
    const id = await s.open();
    s.boom = point;
    const batch = await s.until(id);
    assert.equal(s.boom, null, 'điểm chết phải được chạm tới');
    assert.equal(batch.state, 'done');
    assertOnce(s, id, batch.data.lanes[0].commit);
  });
}

test('a crash right after the final transition to Resolved does not repeat it', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'delivering');
  s.boom = 'jira.transition';
  const batch = await s.until(id);
  assertOnce(s, id, batch.data.lanes[0].commit);
});

test('a crash while claiming after the transition keeps the ticket although it is now In Progress', async t => {
  const s = setup(t);
  const id = await s.open();
  s.boom = 'jira.transition';
  const first = await s.advance(id);
  assert.equal(first.changed, false);
  assert.equal(s.fake.issues['AAP1-1'].status, 'In Progress');
  s.now += 3 * 60 * 1000;
  await s.advance(id);
  assert.deepEqual(s.batch(id).data.todo, ['AAP1-1']);
});

test('a job already enqueued before a crash is not enqueued again, even when finished', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'fixing');
  await s.advance(id);
  s.work();
  await s.advance(id);
  assert.deepEqual(s.jobKeys(), [`bug ${id}#r1`]);
  assert.equal(jobs.listJobs(s.db).length, 1);
});

test('a batch whose merge moved the ref but was never saved merges again from the same base', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'merging');
  const before = s.ref(BRANCH);
  s.boom = 'merge.mergeBatch';
  await s.advance(id);
  assert.notEqual(s.ref(BRANCH), before);
  assert.equal(s.batch(id).data.before, before);
  s.now += 3 * 60 * 1000;
  await s.advance(id);
  assert.equal(g(s.mirror, 'rev-parse', `${s.batch(id).data.sha}^1`), before);
});

test('errors back off 3, 6, 12, 15 minutes and open one dev wait after 30 minutes, closed on success', async t => {
  const s = setup(t);
  const id = await s.open();
  s.before['jira.issue'] = () => { throw new Error('Jira 503'); };
  const tries = [];
  for (let minute = 0; minute <= 40; minute++) {
    const before = s.rows("SELECT id FROM decisions WHERE code = 'X06'").length;
    await s.advance(id);
    if (s.rows("SELECT id FROM decisions WHERE code = 'X06'").length > before) tries.push(minute);
    s.now += 60 * 1000;
  }
  assert.deepEqual(tries, [0, 3, 9, 21, 36]);
  assert.equal(s.waits('dev').length, 1);
  delete s.before['jira.issue'];
  s.now += 15 * 60 * 1000;
  await s.advance(id);
  assert.deepEqual(s.waits('dev'), []);
});
