const { test } = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('../src/jobs.cjs');
const { openDb } = require('../src/db.cjs');
const { world, NOW } = require('./supervisor-fixtures.cjs');

test('claimNext resets log_offset, last_event_at and log_file for the new attempt', () => {
  const w = world();
  const { id } = w.run('x');
  jobs.updateProgress(w.db, id, { logOffset: 77, lastEventAt: NOW + 5 });
  jobs.requeue(w.db, id, NOW, { keepSession: true });
  const again = w.claim(NOW + 10);
  assert.equal(again.attempt, 2);
  assert.equal(again.logOffset, 0);
  assert.equal(again.lastEventAt, null);
  assert.equal(again.logFile, null);
});

test('requeueForResume takes one turn, keeps the session and returns null when no turn is left', () => {
  const w = world();
  const first = w.run('x');
  const queued = jobs.requeueForResume(w.db, first.id, NOW, { max: 1 });
  assert.equal(queued.state, 'queued');
  assert.equal(queued.resumes, 1);
  assert.equal(queued.resume, true);
  assert.equal(queued.sessionId, first.sessionId);
  assert.equal(queued.slotsGranted, 0);
  const again = w.claim();
  jobs.markRunning(w.db, again.id, { pid: 9, pidStart: 's', sessionId: again.sessionId, logFile: '/l' }, NOW);
  assert.equal(jobs.requeueForResume(w.db, first.id, NOW, { max: 1 }), null);
  assert.equal(w.job(first.id).state, 'running');
  assert.equal(w.job(first.id).resumes, 1);
});

test('requeueForResume on a job that is not running throws and takes no turn', () => {
  const w = world();
  const { id } = w.run('x');
  const other = openDb(w.file);
  jobs.requeueForResume(other, id, NOW, { max: 5 });
  assert.throws(() => jobs.requeueForResume(w.db, id, NOW, { max: 5 }), /queued/);
  assert.equal(w.job(id).resumes, 1);
  assert.throws(() => jobs.requeueForResume(w.db, 999, NOW, { max: 5 }), /999/);
});

test('requeueForResume without the session takes the turn and drops the session', () => {
  const w = world();
  const { id } = w.run('x');
  const queued = jobs.requeueForResume(w.db, id, NOW, { max: 1, keepSession: false });
  assert.deepEqual([queued.resumes, queued.resume, queued.sessionId], [1, false, null]);
});

test('a starting job that really ran keeps its session in requeueForResume and requeue', () => {
  const w = world();
  w.add('x');
  const one = w.claim();
  const resumed = jobs.requeueForResume(w.db, one.id, NOW, { max: 1 });
  assert.deepEqual([resumed.resume, resumed.sessionId], [true, one.sessionId]);
  w.add('y');
  w.claim();
  const two = w.claim();
  const queued = jobs.requeue(w.db, two.id, NOW, { keepSession: true, ran: true });
  assert.deepEqual([queued.resume, queued.sessionId, queued.resumes], [true, two.sessionId, 0]);
});
