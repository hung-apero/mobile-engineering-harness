const { test } = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../src/jobs.cjs');
const { supervise } = require('../src/supervisor.cjs');
const { world, ev, rulesFor, NOW } = require('./supervisor-fixtures.cjs');

const pass = (w, extra = {}) => supervise(w.db, { rulesFor, deps: w.deps, now: NOW, boot: false, ...extra });
const kinds = out => out.actions.map(a => [a.type, a.code]);
const step = { type: 'assistant', parent_tool_use_id: null };
const stepFailed = ev.ok({ is_error: true, result: JSON.stringify({ steps: [{ name: 'compile', ok: false }] }) });

function runKind(w, kind) {
  jobs.enqueue(w.db, { project: 'a', kind, key: kind, priority: 1, slots: 1, payload: {} }, NOW);
  return w.start();
}

test('a failed step ends a gate or build job without a resume', async () => {
  for (const kind of ['gate', 'build']) {
    const w = world();
    const job = runKind(w, kind);
    w.log(job.id, step, stepFailed);
    w.die(job);
    assert.deepEqual(kinds(await pass(w)), [['failed', null]]);
    const ended = w.job(job.id);
    assert.deepEqual([ended.state, ended.resumes, ended.result.error], ['failed', 0, 'step_failed']);
    assert.equal(JSON.parse(ended.result.text).steps[0].name, 'compile');
  }
});

test('the same result from an agent job is still resumed', async () => {
  for (const kind of ['feature', 'bug', 'review']) {
    const w = world();
    const job = runKind(w, kind);
    w.log(job.id, step, stepFailed);
    w.die(job);
    assert.deepEqual(kinds(await pass(w)), [['resumed', 'X02']]);
  }
});

test('a command job that died without a result is resumed once, then fails as no_result', async () => {
  const w = world();
  const job = runKind(w, 'build');
  w.log(job.id, step);
  w.die(job);
  assert.deepEqual(kinds(await pass(w)), [['resumed', 'X02']]);
  const again = w.start();
  assert.equal(again.id, job.id);
  w.log(again.id, step);
  w.die(again);
  assert.deepEqual(kinds(await pass(w)), [['failed', 'X02']]);
  assert.equal(w.job(job.id).result.error, 'no_result');
});

test('a failed step found after a reboot is not run again', async () => {
  const w = world();
  const job = runKind(w, 'gate');
  w.log(job.id, step, stepFailed);
  w.die(job);
  w.deps.bootTime = () => NOW + 1;
  assert.deepEqual(kinds(await pass(w, { boot: true })), [['failed', null]]);
});
