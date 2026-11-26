const { test } = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../src/jobs.cjs');
const { makeHome, add, NOW } = require('./service-fixtures.cjs');

function failed(ctx, key) {
  const id = add(ctx, 'ABC1', key);
  jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW });
  jobs.markRunning(ctx.db, id, { pid: 4242, pidStart: 's', sessionId: 'cũ', logFile: 'l' }, NOW);
  jobs.requeueForResume(ctx.db, id, NOW, { max: 1 });
  jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW });
  jobs.finish(ctx.db, id, 'failed', { error: 'x', text: 'y' }, NOW);
  return id;
}

test('dz retry puts a failed job back with a fresh session, no resume used and no old result', t => {
  const h = makeHome(t);
  const ctx = h.context();
  const id = failed(ctx, 'x');
  const out = h.dz('retry', String(id));
  assert.equal(out.status, 0, out.stderr);
  const job = jobs.getJob(ctx.db, id);
  assert.deepEqual(
    [job.state, job.sessionId, job.resume, job.resumes, job.finishedAt, job.result, job.pid],
    ['queued', null, false, 0, null, null, null],
  );
});

test('dz retry refuses a failed job while another open job has the same key and names it', t => {
  const h = makeHome(t);
  const ctx = h.context();
  const id = failed(ctx, 'x');
  const open = add(ctx, 'ABC1', 'x');
  const out = h.dz('retry', String(id));
  assert.equal(out.status, 1);
  assert.match(out.stderr, new RegExp(`việc #${open} cùng khoá đang mở`));
  assert.doesNotMatch(out.stderr, /UNIQUE|\n\s+at /);
  assert.equal(jobs.getJob(ctx.db, id).state, 'failed');
  jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW });
  jobs.finish(ctx.db, open, 'done', null, NOW);
  assert.equal(h.dz('retry', String(id)).status, 0);
});

test('dz retry refuses a job that is queued or done', t => {
  const h = makeHome(t);
  const ctx = h.context();
  const id = add(ctx, 'ABC1', 'x');
  assert.match(h.dz('retry', String(id)).stderr, /không ở trạng thái gác hay lỗi/);
  jobs.claimNext(ctx.db, { projects: new Set(['ABC1']), limits: ctx.rulesFor().limits, now: NOW });
  jobs.finish(ctx.db, id, 'done', null, NOW);
  assert.equal(h.dz('retry', String(id)).status, 1);
});
