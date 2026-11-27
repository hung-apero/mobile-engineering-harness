const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadQuota, observeQuota } = require('../src/quota.cjs');
const { intakeState } = require('../src/intake-state.cjs');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const { makeHome, add, fakeWorkers, NOW, MIN } = require('./service-fixtures.cjs');

const HOUR = 60 * MIN;
const quota = (status, utilization, resetsAt) => ({ status, utilization, resetsAt: resetsAt === null ? null : resetsAt / 1000 });

function setup(t) {
  const h = makeHome(t);
  const ctx = h.context();
  return { h, ctx, rules: ctx.rulesFor().rules, see: (q, at) => observeQuota(ctx.db, { quota: q, at }) };
}

test('the newest observation wins: a stale one never overrides it, a newer milder one reopens intake', t => {
  const { ctx, rules, see } = setup(t);
  const state = now => intakeState(ctx, rules, now);
  see(quota('rejected', 1, NOW + HOUR), NOW);
  see(quota('allowed', 0.3, NOW + 9 * HOUR), NOW - MIN);
  assert.deepEqual(state(NOW + MIN), { open: false, code: 'X01', until: NOW + HOUR });
  see(quota('allowed', 0.3, NOW + 9 * HOUR), NOW + 10 * MIN);
  assert.deepEqual(state(NOW + 10 * MIN), { open: true });
  see(quota('allowed', 0.9, NOW + HOUR), NOW + 9 * MIN);
  assert.equal(loadQuota(ctx.db, NOW + 10 * MIN).utilization, 0.3);
  see(quota('allowed', 0.9, NOW + HOUR), NOW + 10 * MIN);
  assert.equal(loadQuota(ctx.db, NOW + 10 * MIN).utilization, 0.9);
  see(quota('allowed', 0.1, NOW + HOUR), NOW + 10 * MIN);
  assert.equal(loadQuota(ctx.db, NOW + 10 * MIN).utilization, 0.9);
});

test('a rejection holds intake five minutes whatever the reset time says and whatever arrives meanwhile', t => {
  const { ctx, rules, see } = setup(t);
  see(quota('rejected', 1, NOW - HOUR), NOW);
  see(quota('allowed', 0.1, NOW + HOUR), NOW + MIN);
  assert.deepEqual(intakeState(ctx, rules, NOW + 5 * MIN - 1), { open: false, code: 'X01', until: NOW + 5 * MIN });
  assert.deepEqual(intakeState(ctx, rules, NOW + 5 * MIN), { open: true });
});

test('a stopping quota without a reset time closes intake until it is forgotten after five hours', t => {
  const { ctx, rules, see } = setup(t);
  see(quota('rejected', null, null), NOW);
  assert.deepEqual(intakeState(ctx, rules, NOW + HOUR), { open: false, code: 'X01', until: NOW + 5 * HOUR });
  assert.deepEqual(intakeState(ctx, rules, NOW + 5 * HOUR), { open: true });
});

for (const [name, resetsAt] of [['past', NOW / 1000 - 60], ['missing', undefined]]) {
  test(`workers rejected at once with a ${name} reset time: ten ticks start at most one`, async t => {
    const h = makeHome(t);
    const ctx = h.context();
    const { calls } = fakeWorkers(ctx);
    ctx.startWorker = options => {
      calls.push(options);
      fs.appendFileSync(options.logFile, `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } })}\n`);
      return { pid: 900001, pidStart: 's' };
    };
    const id = add(ctx, 'ABC1', 'a');
    for (let i = 0; i < 10; i++) await tick(ctx, NOW + i * 10000);
    assert.equal(calls.length, 1);
    assert.equal(jobs.getJob(ctx.db, id).state, 'queued');
  });
}

test('dz status shows the quota and until when intake is closed', t => {
  const { h, see } = setup(t);
  const now = Date.now();
  see(quota('rejected', 0.97, now + 2 * HOUR), now);
  const out = h.dz('status').stdout;
  assert.match(out, /Hạn mức: 97%.*rejected.*đóng nhận việc tới \d/);
  assert.match(out, /Nhận việc: đóng \(X01 tới \d/);
});
