const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { bugStep } = require('../src/bugs/step.cjs');
const { release } = require('../src/release-commands.cjs');
const { ExpectedError } = require('../src/run.cjs');
const jobs = require('../src/jobs.cjs');
const { setup, issue, NOW, MIN } = require('./bugs-step-fixtures.cjs');

const TREE = 'a'.repeat(40);

function world(t) {
  const s = setup(t);
  s.ctx.bugs.versionTip = async () => ({ sha: 'b'.repeat(40), tree: TREE });
  s.turnOn();
  s.locks = [];
  s.ctx.e2e = { devices: { releaseAll: async ({ prefix }) => { s.locks.push(prefix); return []; }, pick: async () => null, acquire: async () => null } };
  return s;
}

test('a finished E2E is settled by the service step, frees the device and re-checks the release at once', async t => {
  const s = world(t);
  await bugStep(s.ctx, s.config(), NOW);
  const { id } = jobs.enqueue(s.ctx.db, { project: 'ABC1', kind: 'e2e', key: '1.9.2#1', priority: 1, slots: 1, payload: {} }, NOW);
  s.ctx.db.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(id);
  kv.set(s.ctx.db, 'e2e:ABC1:1.9.2', { run: { jobId: id, tree: TREE, sha: 'b'.repeat(40), build: { apk: '/none', sha256: 'x' } }, waits: {}, failedRounds: 0 }, NOW);
  await bugStep(s.ctx, s.config(), NOW + MIN);
  assert.deepEqual(s.locks, ['spec:e2e-ABC1-1-9-2:']);
  assert.equal(kv.get(s.ctx.db, 'e2e:ABC1:1.9.2').run, null);
  assert.equal(kv.get(s.ctx.db, 'bug-release:ABC1:1.9.2').at, NOW + MIN);
});

test('a Medium bug found after closing is not taken by polling', async t => {
  const s = world(t);
  s.fake.issues['ABC1-1'] = issue('To Do', { priority: 'Medium' });
  s.fake.issues['ABC1-2'] = issue('To Do', { priority: 'High' });
  kv.set(s.ctx.db, 'release-closed:ABC1:1.9.2', { at: NOW }, NOW);
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(store.getTicket(s.ctx.db, 'ABC1', 'ABC1-1'), null);
  assert.equal(store.getTicket(s.ctx.db, 'ABC1', 'ABC1-2').state !== undefined, true);
});

test('dz release: status prints six conditions, defer names who, done closes; a bad order is an expected error', async t => {
  const s = world(t);
  s.fake.issues['ABC1-1'] = issue('To Do', { priority: 'Low' });
  const lines = await release(s.ctx, ['status', 'ABC1', '1.9.2'], NOW);
  for (let n = 1; n <= 6; n += 1) assert.ok(lines.some(line => line.startsWith(`  ${n}. `)), lines.join('\n'));
  assert.match((await release(s.ctx, ['defer', 'ABC1', '1.9.2', 'ABC1-1', '--by', 'PO Hà'], NOW))[0], /ABC1-1 \(PO Hà\)/);
  assert.match((await release(s.ctx, ['status', 'ABC1', '1.9.2'], NOW)).join('\n'), /Hoãn ABC1-1: PO Hà/);
  await assert.rejects(release(s.ctx, ['defer', 'ABC1', '1.9.2', 'ABC1-9', '--by', 'PO'], NOW), ExpectedError);
  await assert.rejects(release(s.ctx, ['e2e', 'ABC1', '1.9.2', 'accept', '--by', 'Lan'], NOW), ExpectedError);
  await assert.rejects(release(s.ctx, ['done', 'ABC1', '9.9'], NOW), ExpectedError);
  assert.match((await release(s.ctx, ['done', 'ABC1', '1.9.2'], NOW))[0], /release ABC1 1\.9\.2/);
  assert.equal(store.getVersion(s.ctx.db, 'ABC1', '1.9.2').state, 'closed');
});
