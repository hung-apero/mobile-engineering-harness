const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const { blockStarts } = require('../src/intake-state.cjs');
const { makeHome, add, fakeWorkers, NOW, MIN } = require('./service-fixtures.cjs');

const openWaits = ctx => ctx.db.prepare("SELECT role, subject FROM waits WHERE state = 'open'").all();

test('I3: intake closed for over 30 minutes opens one dev wait per project, closed when intake opens', async t => {
  const h = makeHome(t, ['ABC1', 'DEF2']);
  const ctx = h.context();
  fakeWorkers(ctx);
  ctx.freeGb = () => -1;
  await tick(ctx, NOW);
  await tick(ctx, NOW + 29 * MIN);
  assert.equal(openWaits(ctx).length, 0);
  await tick(ctx, NOW + 31 * MIN);
  await tick(ctx, NOW + 40 * MIN);
  const waits = openWaits(ctx);
  assert.equal(waits.length, 2);
  assert.ok(waits.every(w => w.role === 'dev' && w.subject.includes('X05')));
  ctx.freeGb = () => 500;
  await tick(ctx, NOW + 41 * MIN);
  assert.equal(openWaits(ctx).length, 0);
  ctx.freeGb = () => -1;
  await tick(ctx, NOW + 42 * MIN);
  await tick(ctx, NOW + 50 * MIN);
  assert.equal(openWaits(ctx).length, 0);
});

function commandKinds(ctx) {
  const prepare = () => ({ command: { bin: '/bin/echo', args: ['hi'] }, cwd: ctx.dzHome, env: {} });
  ctx.handlers = { ...ctx.handlers, gate: { prepare }, build: { prepare } };
}

test('X08 and X01 closed intake still start gate and build jobs, never a code agent', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  commandKinds(ctx);
  blockStarts(ctx.db, 'claude missing', NOW);
  const probe = add(ctx, 'ABC1', 'p');
  const gate = add(ctx, 'ABC1', 'g', { kind: 'gate' });
  const build = add(ctx, 'ABC1', 'b', { kind: 'build' });
  await tick(ctx, NOW + MIN);
  assert.equal(jobs.getJob(ctx.db, probe).state, 'queued');
  assert.equal(jobs.getJob(ctx.db, gate).state, 'running');
  assert.equal(jobs.getJob(ctx.db, build).state, 'queued');
  assert.equal(calls.length, 1);
});

test('X05 closed intake holds gate and build jobs too', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  commandKinds(ctx);
  ctx.freeGb = () => -1;
  const gate = add(ctx, 'ABC1', 'g', { kind: 'gate' });
  await tick(ctx, NOW);
  assert.equal(jobs.getJob(ctx.db, gate).state, 'queued');
  assert.equal(calls.length, 0);
});
