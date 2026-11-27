const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const store = require('../src/bugs/store.cjs');
const { observeQuota } = require('../src/quota.cjs');
const { blockStarts } = require('../src/intake-state.cjs');
const { makeHome, add, fakeWorkers, NOW, MIN } = require('./service-fixtures.cjs');

const DAY = 24 * 60 * MIN;

for (const [code, close] of [
  ['X08', ctx => blockStarts(ctx.db, 'claude missing', NOW)],
  ['X01', ctx => observeQuota(ctx.db, { quota: { status: 'rejected', utilization: 1, resetsAt: (NOW + DAY) / 1000 }, at: NOW })],
]) {
  test(`N5: low disk holds gate and build although ${code} is the reported code`, async t => {
    const h = makeHome(t);
    const ctx = h.context();
    const { calls } = fakeWorkers(ctx);
    const prepare = () => ({ command: { bin: '/bin/echo', args: ['hi'] }, cwd: ctx.dzHome, env: {} });
    ctx.handlers = { ...ctx.handlers, gate: { prepare }, build: { prepare } };
    close(ctx);
    ctx.freeGb = () => -1;
    const gate = add(ctx, 'ABC1', 'g', { kind: 'gate' });
    await tick(ctx, NOW + MIN);
    assert.equal(h.logs('intake').at(-1).code, code);
    assert.equal(jobs.getJob(ctx.db, gate).state, 'queued');
    assert.equal(calls.length, 0);
    ctx.freeGb = () => 500;
    await tick(ctx, NOW + 2 * MIN);
    assert.equal(jobs.getJob(ctx.db, gate).state, 'running');
  });
}

test('dz retry refuses a job whose batch is finished and accepts one whose batch runs', t => {
  const h = makeHome(t);
  const ctx = h.context();
  store.ensureVersion(ctx.db, { project: 'ABC1', version: '1.9.2' });
  const batch = state => Number(ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', ?, '[]', 1, 1)").run(state).lastInsertRowid);
  for (const [state, status] of [['done', 1], ['abandoned', 1], ['running', 0]]) {
    const id = batch(state);
    const job = add(ctx, 'ABC1', `${id}#g1`, { kind: 'gate' });
    ctx.db.prepare("UPDATE jobs SET state = 'failed' WHERE id = ?").run(job);
    const out = h.dz('retry', String(job));
    assert.equal(out.status, status, state);
    if (status) assert.match(out.stderr, new RegExp(`đợt #${id}`));
    assert.equal(jobs.getJob(ctx.db, job).state, status ? 'failed' : 'queued');
  }
});

test('batch evidence older than 30 days is pruned, younger evidence and anything else stays', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  fakeWorkers(ctx);
  const root = path.join(h.dzHome, 'logs', 'batches');
  const dir = (name, age) => {
    fs.mkdirSync(path.join(root, name, 'gate-000000000000'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'gate-000000000000', 'result.json'), '{}');
    fs.utimesSync(path.join(root, name), (NOW - age) / 1000, (NOW - age) / 1000);
  };
  dir('ABC1-1', 31 * DAY);
  dir('ABC1-2', 29 * DAY);
  dir('notes', 31 * DAY);
  const outside = path.join(h.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'ABC1-3'));
  fs.lutimesSync(path.join(root, 'ABC1-3'), 1, 1);
  await tick(ctx, NOW);
  assert.deepEqual(fs.readdirSync(root).sort(), ['ABC1-2', 'ABC1-3', 'notes']);
  assert.ok(fs.existsSync(outside));
});
