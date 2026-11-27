const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supervise } = require('../src/supervisor.cjs');
const { world, ev, rulesFor, NOW, MIN } = require('./supervisor-fixtures.cjs');

const pass = (w, extra = {}) => supervise(w.db, { rulesFor, deps: w.deps, now: NOW, boot: false, ...extra });
const seen = out => out.quotas.map(q => [q.quota.status, q.at]);

test('a live worker quota is observed when it was read, never later than the last write to the log', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.quota('allowed'));
  assert.deepEqual(seen(await pass(w, { now: NOW + MIN })), [['allowed', NOW + MIN]]);
  w.log(job.id, ev.quota('rejected'));
  w.deps.modifiedAt = () => NOW + 2 * MIN;
  assert.deepEqual(seen(await pass(w, { now: NOW + 9 * MIN })), [['rejected', NOW + 2 * MIN]]);
});

test('a dead worker: an unread quota is dated by the log file, one already read is never newer than the attempt start', async () => {
  const w = world();
  const unread = w.run('x');
  w.log(unread.id, ev.quota('rejected'));
  w.deps.modifiedAt = () => NOW + MIN;
  w.die(unread);
  assert.deepEqual(seen(await pass(w, { now: NOW + 30 * MIN, boot: true })), [['rejected', NOW + MIN]]);
  const read = w.run('y', 'a', NOW + 31 * MIN);
  w.log(read.id, ev.quota('allowed'));
  await pass(w, { now: NOW + 32 * MIN });
  w.log(read.id, ev.text(1), ev.ok());
  w.die(read);
  assert.deepEqual(seen(await pass(w, { now: NOW + 33 * MIN })), [['allowed', NOW + 31 * MIN]]);
});
