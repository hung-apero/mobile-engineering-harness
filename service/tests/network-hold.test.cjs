const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const kv = require('../src/kv.cjs');
const { makeHome, add, fakeWorkers, NOW } = require('./service-fixtures.cjs');

const LOST = { type: 'result', subtype: 'success', is_error: true, api_error: 'connection_failed', num_turns: 1, result: "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)" };

test('a job that lost the API connection waits for the network, then runs again without using a resume', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls, alive } = fakeWorkers(ctx);
  let online = false;
  ctx.deps = { ...ctx.deps, reachable: async () => online };
  const id = add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  assert.equal(calls.length, 1);
  const job = jobs.getJob(ctx.db, id);
  fs.mkdirSync(path.dirname(job.logFile), { recursive: true });
  fs.appendFileSync(job.logFile, `${JSON.stringify(LOST)}\n`);
  alive.delete(job.pid);
  await tick(ctx, NOW + 10000);
  await tick(ctx, NOW + 20000);
  assert.equal(calls.length, 1);
  assert.deepEqual([jobs.getJob(ctx.db, id).state, jobs.getJob(ctx.db, id).resumes], ['queued', 0]);
  assert.ok(kv.get(ctx.db, 'offline'));
  online = true;
  await tick(ctx, NOW + 30000);
  assert.equal(calls.length, 2);
  assert.equal(kv.get(ctx.db, 'offline'), null);
  assert.equal(jobs.getJob(ctx.db, id).state, 'running');
});
