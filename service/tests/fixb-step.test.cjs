const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const polling = require('../src/bugs/polling.cjs');
const health = require('../src/health.cjs');
const { bugStep } = require('../src/bugs/step.cjs');
const { requestPark } = require('../src/bugs/park-request.cjs');
const { setup, NOW, MIN } = require('./bugs-step-fixtures.cjs');

const batchRow = (s, state) => {
  store.ensureVersion(s.ctx.db, { project: 'ABC1', version: '1.9.2' });
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', ?, '[]', 1, 1)").run(state);
};

test('I2: a paused project does not claim an open batch but still advances a running one', async t => {
  const s = setup(t);
  batchRow(s, 'open');
  batchRow(s, 'running');
  health.setProjectState(s.ctx.db, 'ABC1', { paused: true });
  await bugStep(s.ctx, s.config(), NOW);
  assert.deepEqual(s.advances.map(a => a.batch.state), ['running']);
});

test('I2: closed intake does not claim an open batch but still advances a running one', async t => {
  const s = setup(t);
  batchRow(s, 'open');
  batchRow(s, 'running');
  s.ctx.freeGb = () => -1;
  await bugStep(s.ctx, s.config(), NOW);
  assert.deepEqual(s.advances.map(a => a.batch.state), ['running']);
  s.ctx.freeGb = () => 500;
  await bugStep(s.ctx, s.config(), NOW + MIN);
  assert.ok(s.advances.some(a => a.batch.state === 'open'));
});

test('I7: a park request reaches an open batch of a paused or blocked project', async t => {
  const s = setup(t);
  batchRow(s, 'open');
  batchRow(s, 'open');
  const [first] = store.listBatches(s.ctx.db, { project: 'ABC1' });
  requestPark(s.ctx.db, first.id, NOW);
  health.setProjectState(s.ctx.db, 'ABC1', { paused: true });
  await bugStep(s.ctx, s.config(), NOW);
  assert.deepEqual(s.advances.map(a => a.batch.id), [first.id]);
  health.setProjectState(s.ctx.db, 'ABC1', { paused: false });
  for (let i = 1; i <= 3; i++) {
    s.ctx.db.prepare("INSERT INTO jobs (project, kind, key, priority, slots, state, created_at, finished_at, payload) VALUES ('ABC1', 'bug', ?, 1, 1, 'failed', ?, ?, '{}')").run(`k${i}`, NOW, NOW + i);
  }
  s.advances.length = 0;
  await bugStep(s.ctx, s.config(), NOW + MIN);
  assert.deepEqual(s.advances.map(a => a.batch.id), [first.id]);
});

test('I10: a build sent after dz bugs off does not turn polling back on', t => {
  const s = setup(t);
  s.turnOn();
  polling.setPolling(s.ctx.db, 'ABC1', '1.9.2', false, NOW);
  polling.recordBuildSent(s.ctx.db, 'ABC1', '1.9.2', NOW + MIN);
  assert.equal(store.getVersion(s.ctx.db, 'ABC1', '1.9.2').polling, false);
  polling.setPolling(s.ctx.db, 'ABC1', '1.9.2', true, NOW + 2 * MIN);
  polling.recordBuildSent(s.ctx.db, 'ABC1', '1.9.2', NOW + 3 * MIN);
  assert.equal(store.getVersion(s.ctx.db, 'ABC1', '1.9.2').polling, true);
});

function waitingTicket(s) {
  s.turnOn();
  s.ctx.db.prepare("UPDATE versions SET last_poll_at = ?, polling = 0").run(NOW - MIN);
  s.ctx.db.prepare("INSERT INTO tickets (project, key, version, priority, state, fingerprint, updated_at) VALUES ('ABC1', 'ABC1-1', '1.9.2', 1, 'accepted', 'x', ?)").run(NOW - MIN);
}

test('I10: batches are planned without polling, but not when the operator turned the version off or the project is paused', async t => {
  const s = setup(t);
  waitingTicket(s);
  kv.set(s.ctx.db, 'bug-off:ABC1:1.9.2', true, NOW);
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(store.listBatches(s.ctx.db, { project: 'ABC1' }).length, 0);
  kv.del(s.ctx.db, 'bug-off:ABC1:1.9.2');
  health.setProjectState(s.ctx.db, 'ABC1', { paused: true });
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(store.listBatches(s.ctx.db, { project: 'ABC1' }).length, 0);
  health.setProjectState(s.ctx.db, 'ABC1', { paused: false });
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(store.listBatches(s.ctx.db, { project: 'ABC1' }).length, 1);
});
