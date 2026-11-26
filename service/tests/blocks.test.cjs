const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const health = require('../src/health.cjs');
const { makeHome, add, fakeWorkers, NOW, MIN } = require('./service-fixtures.cjs');

const decisions = (ctx, code) => ctx.db.prepare('SELECT * FROM decisions WHERE code = ? ORDER BY id').all(code);

test('a blocked project claims nothing, records X07 and one wait per episode, and resolves when it clears', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  for (const key of ['a', 'b', 'c']) {
    const id = add(ctx, 'ABC1', key);
    jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW - MIN });
    jobs.finish(ctx.db, id, 'failed', null, NOW - MIN);
  }
  add(ctx, 'ABC1', 'd');
  await tick(ctx, NOW);
  await tick(ctx, NOW + 10000);
  assert.equal(calls.length, 0);
  assert.equal(decisions(ctx, 'X07').length, 1);
  const waits = () => ctx.db.prepare('SELECT * FROM waits').all();
  assert.equal(waits().length, 1);
  assert.equal(waits()[0].role, 'dev');
  assert.match(waits()[0].subject, /ABC1.*X07/);
  health.setProjectState(ctx.db, 'ABC1', { resumedAt: NOW + 15000 });
  await tick(ctx, NOW + 20000);
  assert.equal(calls.length, 1);
  assert.equal(waits()[0].state, 'resolved');
});

test('a parked job opens one dev wait, resolved once it is no longer parked', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  fakeWorkers(ctx);
  ctx.handlers = {};
  const id = add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  await tick(ctx, NOW + 10000);
  const waits = () => ctx.db.prepare('SELECT * FROM waits').all();
  assert.equal(waits().length, 1);
  assert.match(waits()[0].subject, new RegExp(`#${id}.*ABC1.*handler`));
  jobs.retry(ctx.db, id, NOW + 15000);
  ctx.stopping = true;
  await tick(ctx, NOW + 20000);
  assert.equal(waits()[0].state, 'resolved');
});

test('waits of a disabled or removed project are resolved; a broken config keeps them', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  fakeWorkers(ctx);
  ctx.handlers = {};
  for (const key of ['a', 'b', 'c']) {
    const id = add(ctx, 'ABC1', key);
    jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW - MIN });
    if (key === 'c') jobs.park(ctx.db, id, 'x', NOW - MIN);
    else jobs.finish(ctx.db, id, 'failed', null, NOW - MIN);
  }
  const extra = add(ctx, 'ABC1', 'd');
  jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW - MIN });
  jobs.finish(ctx.db, extra, 'failed', null, NOW - MIN);
  const open = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM waits WHERE state = 'open'").get().n;
  await tick(ctx, NOW);
  assert.equal(open(), 2);
  h.project('ABC1', { repo: 'sai' });
  await tick(ctx, NOW + 10000);
  assert.equal(open(), 2);
  h.project('ABC1', { enabled: false });
  await tick(ctx, NOW + 20000);
  await tick(ctx, NOW + 30000);
  assert.equal(open(), 0);
  h.project('ABC1');
  await tick(ctx, NOW + 40000);
  assert.equal(open(), 2);
  fs.rmSync(path.join(h.dzHome, 'projects', 'ABC1.yaml'));
  await tick(ctx, NOW + 50000);
  assert.equal(open(), 0);
});
