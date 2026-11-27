const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');
const jobs = require('../src/jobs.cjs');
const health = require('../src/health.cjs');

const rules = { X01: { stop_new_at: 0.8 }, X05: { min_free_gb: 15 }, X07: { max_consecutive_failures: 3 } };
const memDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-health-')), 'dz.db'));
const NOW = Date.parse('2026-11-25T10:00:00+07:00');
const quota = (utilization, resetsAt = NOW / 1000 + 3600, status = 'allowed') => ({ utilization, resetsAt, status });

test('utilization 0.8 closes intake, 0.79 opens; passed resetsAt opens again', () => {
  assert.deepEqual(health.intake({ quota: quota(0.8), rules, now: NOW }), { open: false, code: 'X01', until: NOW + 3600000 });
  assert.deepEqual(health.intake({ quota: quota(0.79), rules, now: NOW }), { open: true });
  assert.deepEqual(health.intake({ quota: quota(0.95, NOW / 1000 - 1), rules, now: NOW }), { open: true });
  assert.equal(health.intake({ quota: quota(0.1, NOW / 1000 + 60, 'rejected'), rules, now: NOW }).code, 'X01');
});

test('unknown quota keeps intake open', () => {
  assert.deepEqual(health.intake({ quota: null, rules, now: NOW }), { open: true });
  assert.deepEqual(health.intake({ rules, freeGb: undefined, now: NOW }), { open: true });
});

test('free 14 GB closes, 15 opens', () => {
  assert.deepEqual(health.intake({ freeGb: 14, rules, now: NOW }), { open: false, code: 'X05' });
  assert.deepEqual(health.intake({ freeGb: 15, rules, now: NOW }), { open: true });
  assert.equal(health.intake({ quota: quota(0.9), freeGb: 1, rules, now: NOW }).code, 'X01');
  assert.ok(health.freeGb(os.tmpdir()) > 0);
});

function runJob(db, project, key, state, at) {
  const { id } = jobs.enqueue(db, { project, kind: 'bug', key, priority: 1, slots: 1 }, at);
  db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(id);
  if (state === 'parked') jobs.park(db, id, 'X02: im', at);
  else jobs.finish(db, id, state, null, at);
}

test('three failures in a row block only that project; a success in between resets; resume-project clears', () => {
  const db = memDb();
  runJob(db, 'A', 'a1', 'failed', 1);
  runJob(db, 'A', 'a2', 'failed', 2);
  runJob(db, 'B', 'b1', 'failed', 3);
  assert.equal(health.projectBlocked(db, 'A', rules), false);
  runJob(db, 'A', 'a3', 'parked', 4);
  runJob(db, 'A', 'a4', 'failed', 5);
  assert.equal(health.projectBlocked(db, 'A', rules), true);
  assert.equal(health.projectBlocked(db, 'B', rules), false);
  runJob(db, 'C', 'c1', 'failed', 1);
  runJob(db, 'C', 'c2', 'done', 2);
  runJob(db, 'C', 'c3', 'failed', 3);
  runJob(db, 'C', 'c4', 'failed', 4);
  assert.equal(health.projectBlocked(db, 'C', rules), false);
  health.setProjectState(db, 'A', { resumedAt: 6 });
  assert.equal(health.projectBlocked(db, 'A', rules), false);
  runJob(db, 'A', 'a5', 'failed', 7);
  assert.equal(health.projectBlocked(db, 'A', rules), false);
});

test('X07 ignores failed gate and build jobs, counts review jobs', () => {
  const db = memDb();
  const failed = (kind, key, at) => {
    const { id } = jobs.enqueue(db, { project: 'G', kind, key, priority: 1, slots: 1 }, at);
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(id);
    jobs.finish(db, id, 'failed', null, at);
  };
  failed('gate', 'g1', 1);
  failed('build', 'b1', 2);
  failed('gate', 'g2', 3);
  failed('build', 'b2', 4);
  assert.equal(health.projectBlocked(db, 'G', rules), false);
  failed('review', 'r1', 5);
  failed('bug', 'x1', 6);
  assert.equal(health.projectBlocked(db, 'G', rules), false);
  failed('review', 'r2', 7);
  assert.equal(health.projectBlocked(db, 'G', rules), true);
});

test('paused flag persists and resume keeps it independent', () => {
  const db = memDb();
  assert.equal(health.isPaused(db, 'A'), false);
  health.setProjectState(db, 'A', { paused: true });
  health.setProjectState(db, 'A', { resumedAt: 9 });
  assert.equal(health.isPaused(db, 'A'), true);
  health.setProjectState(db, 'A', { paused: false });
  assert.equal(health.isPaused(db, 'A'), false);
});

test('rejected or over-threshold quota without a finite resetsAt stays closed with no until', () => {
  for (const q of [{ utilization: 0.1, status: 'rejected' }, { utilization: 0.9, resetsAt: NaN, status: 'allowed' }, { utilization: 0.9, resetsAt: null }]) {
    const result = health.intake({ quota: q, rules, now: NOW });
    assert.deepEqual(result, { open: false, code: 'X01' });
    assert.equal(result.until, undefined);
  }
});

test('failures finished exactly at resumedAt count; earlier ones do not', () => {
  const db = memDb();
  for (const key of ['a', 'b', 'c']) runJob(db, 'A', key, 'failed', 100);
  health.setProjectState(db, 'A', { resumedAt: 100 });
  assert.equal(health.projectBlocked(db, 'A', rules), true);
  health.setProjectState(db, 'A', { resumedAt: 101 });
  assert.equal(health.projectBlocked(db, 'A', rules), false);
});
