const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawn } = require('node:child_process');
const { openDb, MIGRATIONS } = require('../src/db.cjs');
const jobs = require('../src/jobs.cjs');

const t = s => Date.parse(`${s}+07:00`);
const NIGHT = t('2026-11-25T20:00:00');
const limits = { code_agents_working: 2, code_agents_off: 3, reserved_for_bug: 1, build: 1, bugs_per_project: 2 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dz-jobs-'));
const memDb = () => openDb(path.join(tmp(), 'dz.db'));
const add = (db, project, kind, key, extra = {}) =>
  jobs.enqueue(db, { project, kind, key, priority: 1, slots: 1, payload: {}, ...extra }, NIGHT);
const claim = (db, projects, now = NIGHT) => jobs.claimNext(db, { projects: new Set(projects), limits, now });
const run = (db, id) => jobs.markRunning(db, id, { pid: 10 + id, pidStart: 5, sessionId: `s${id}`, logFile: `/l/${id}` }, NIGHT);

test('same key twice while open → created false, same id; after done → new id', () => {
  const db = memDb();
  const first = add(db, 'a', 'bug', 'K-1');
  const again = add(db, 'a', 'bug', 'K-1');
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);
  const job = claim(db, ['a']);
  run(db, job.id);
  assert.equal(add(db, 'a', 'bug', 'K-1').id, first.id);
  jobs.finish(db, job.id, 'done', { ok: true }, NIGHT);
  const next = add(db, 'a', 'bug', 'K-1');
  assert.equal(next.created, true);
  assert.notEqual(next.id, first.id);
});

test('Highest is claimed before an older normal job; a running job is never interrupted', () => {
  const db = memDb();
  const normal = add(db, 'a', 'feature', 'f1', { priority: 1 });
  const first = claim(db, ['a']);
  assert.equal(first.id, normal.id);
  assert.equal(first.state, 'starting');
  assert.equal(first.slotsGranted, 1);
  run(db, first.id);
  const older = add(db, 'a', 'feature', 'f2', { priority: 1 });
  const highest = add(db, 'a', 'bug', 'b1', { priority: 0 });
  assert.equal(claim(db, ['a']).id, highest.id);
  assert.equal(jobs.getJob(db, first.id).state, 'running');
  assert.equal(jobs.getJob(db, older.id).state, 'queued');
});

test('two projects alternate', () => {
  const db = memDb();
  add(db, 'a', 'feature', 'a1');
  add(db, 'a', 'feature', 'a2');
  add(db, 'b', 'feature', 'b1');
  add(db, 'b', 'feature', 'b2');
  const order = [];
  for (let i = 0; i < 4; i++) {
    const job = claim(db, ['a', 'b'], NIGHT + i * 1000);
    order.push(job.project);
    jobs.finish(db, job.id, 'done', {}, NIGHT + i * 1000);
  }
  assert.deepEqual(order, ['a', 'b', 'a', 'b']);
});

test('a job that cannot be granted does not block a smaller or bug job behind it', () => {
  const db = memDb();
  add(db, 'a', 'feature', 'busy', { slots: 2 });
  run(db, claim(db, ['a']).id);
  add(db, 'b', 'feature', 'big', { slots: 2, priority: 0 });
  const bug = add(db, 'c', 'bug', 'bug', { slots: 1, priority: 2 });
  assert.equal(claim(db, ['a', 'b', 'c']).id, bug.id);
  assert.equal(claim(db, ['a', 'b', 'c']), null);

  const other = memDb();
  add(other, 'p', 'bug', 'b1', { slots: 2, priority: 0 });
  add(other, 'p', 'bug', 'b2', { slots: 1, priority: 0 });
  const smaller = add(other, 'q', 'bug', 'f', { slots: 1, priority: 1 });
  run(other, claim(other, ['p', 'q']).id);
  assert.equal(claim(other, ['p', 'q']).id, smaller.id);
  assert.equal(claim(other, ['p', 'q']), null);
});

const worker = path.join(__dirname, 'queue-worker.cjs');
const runWorker = (mode, file, startAt) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [worker, mode, file, String(startAt)]);
  let out = '';
  let err = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (err += d));
  child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err))));
});

test('two connections claiming at once get different jobs', async () => {
  const file = path.join(tmp(), 'dz.db');
  const db = openDb(file);
  add(db, 'a', 'feature', 'x');
  add(db, 'b', 'feature', 'y');
  db.close();
  const startAt = Date.now() + 500;
  const ids = (await Promise.all([runWorker('claim', file, startAt), runWorker('claim', file, startAt)])).map(JSON.parse);
  assert.equal(ids.includes(null), false);
  assert.notEqual(ids[0], ids[1]);
});

test('several processes opening the same new file at once all succeed', async () => {
  const file = path.join(tmp(), 'dz.db');
  const startAt = Date.now() + 500;
  const outs = await Promise.all(Array.from({ length: 6 }, () => runWorker('open', file, startAt)));
  assert.deepEqual(outs, Array(6).fill('ok'));
});

test('requeue sees a markRunning done on another connection', () => {
  const file = path.join(tmp(), 'dz.db');
  const one = openDb(file);
  const two = openDb(file);
  const { id } = add(one, 'a', 'feature', 'x');
  claim(one, ['a']);
  run(two, id);
  const job = jobs.requeue(one, id, NIGHT, { keepSession: true });
  assert.equal(job.resume, true);
  assert.equal(job.sessionId, 's' + id);
});

test('progress only touches running jobs', () => {
  const db = memDb();
  const { id } = add(db, 'a', 'feature', 'x');
  jobs.updateProgress(db, id, { logOffset: 5, lastEventAt: 7 });
  assert.equal(jobs.getJob(db, id).logOffset, 0);
  claim(db, ['a']);
  run(db, id);
  jobs.finish(db, id, 'done', {}, NIGHT);
  jobs.updateProgress(db, id, { logOffset: 5, lastEventAt: 7 });
  assert.equal(jobs.getJob(db, id).logOffset, 0);
});

test('illegal transitions throw', () => {
  const db = memDb();
  const { id } = add(db, 'a', 'feature', 'x');
  assert.throws(() => jobs.markRunning(db, id, { pid: 1, pidStart: 1, sessionId: 's', logFile: 'l' }, NIGHT), /queued.*running/);
  run(db, claim(db, ['a']).id);
  jobs.finish(db, id, 'done', {}, NIGHT);
  assert.throws(() => run(db, id), /done.*running/);
  assert.throws(() => jobs.retry(db, id, NIGHT), /done.*queued/);
  assert.throws(() => jobs.park(db, id, 'x', NIGHT), /done.*parked/);
  assert.throws(() => jobs.requeue(db, id, NIGHT, { keepSession: false }), /done.*queued/);
});

test('reopening an existing db keeps data; a newer user_version throws', () => {
  const file = path.join(tmp(), 'dz.db');
  const db = openDb(file);
  const { id } = add(db, 'a', 'feature', 'x', { payload: { n: 1 } });
  db.close();
  const again = openDb(file);
  assert.deepEqual(jobs.getJob(again, id).payload, { n: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  again.close();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  raw.close();
  assert.throws(() => openDb(file), /user_version/);
});

test('requeue keepSession resumes only when the process really started', () => {
  const db = memDb();
  const { id } = add(db, 'a', 'feature', 'x');
  const claimed = claim(db, ['a']);
  assert.ok(claimed.sessionId);
  let job = jobs.requeue(db, id, NIGHT, { keepSession: true });
  assert.equal(job.resume, false);
  assert.equal(job.sessionId, null);
  const second = claim(db, ['a']);
  assert.equal(second.attempt, 2);
  run(db, id);
  job = jobs.requeue(db, id, NIGHT, { keepSession: true });
  assert.equal(job.resume, true);
  assert.equal(job.sessionId, 's' + id);
  assert.equal(claim(db, ['a']).sessionId, 's' + id);
});

test('retry starts a new session and resets resumes; park/progress/listJobs', () => {
  const db = memDb();
  const { id } = add(db, 'a', 'feature', 'x');
  claim(db, ['a']);
  run(db, id);
  jobs.requeueForResume(db, id, NIGHT, { max: 1 });
  claim(db, ['a']);
  run(db, id);
  jobs.updateProgress(db, id, { logOffset: 99, lastEventAt: 123 });
  const parked = jobs.park(db, id, 'hết suất', NIGHT);
  assert.equal(parked.parkReason, 'hết suất');
  assert.equal(parked.resumes, 1);
  assert.equal(parked.logOffset, 99);
  assert.equal(add(db, 'a', 'feature', 'x').id, id);
  const retried = jobs.retry(db, id, NIGHT);
  assert.equal(retried.state, 'queued');
  assert.equal(retried.sessionId, null);
  assert.equal(retried.resume, false);
  assert.equal(retried.resumes, 0);
  assert.deepEqual(jobs.listJobs(db, { states: ['queued'], project: 'a' }).map(j => j.id), [id]);
  assert.deepEqual(jobs.listJobs(db, { states: ['done'] }), []);
});
