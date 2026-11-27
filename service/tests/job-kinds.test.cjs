const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, MIGRATIONS } = require('../src/db.cjs');
const jobs = require('../src/jobs.cjs');
const { grant } = require('../src/slots.cjs');

const HOURS = Date.parse('2026-11-25T10:00:00+07:00');
const limits = { code_agents_working: 2, code_agents_off: 3, reserved_for_bug: 1, build: 1, bugs_per_project: 2 };
const job = (kind, slots = 1, project = 'a') => ({ kind, slots, project });
const running = (kind, slotsGranted = 1, project = 'a') => ({ kind, slotsGranted, project });
const ask = (kind, busy, extra = {}) => grant({ job: job(kind, extra.slots), running: busy, limits: { ...limits, ...extra.limits }, now: HOURS });
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-kinds-')), 'dz.db');

test('gate and build share limits.build machine-wide, one slot each', () => {
  assert.equal(ask('build', [], { slots: 5 }), 1);
  assert.equal(ask('gate', [running('build', 1, 'b')]), 0);
  assert.equal(ask('build', [running('gate', 1, 'b')]), 0);
  assert.equal(ask('gate', [running('build', 1, 'b')], { limits: { build: 2 } }), 1);
  assert.equal(ask('build', [], { limits: { build: 0 } }), 0);
});

test('command jobs ignore agent slots and agents ignore command jobs', () => {
  assert.equal(ask('build', [running('feature'), running('bug')]), 1);
  assert.equal(ask('bug', [running('build'), running('feature')]), 1);
  assert.equal(ask('feature', [running('gate')]), 1);
});

test('review is an agent slot that may use the reserved one, outside bugs_per_project', () => {
  assert.equal(ask('review', [running('feature')]), 1);
  assert.equal(ask('review', [running('feature'), running('bug')]), 0);
  assert.equal(ask('review', [], { limits: { bugs_per_project: 0 } }), 1);
  assert.equal(ask('bug', [running('review')], { limits: { bugs_per_project: 1 } }), 1);
  assert.equal(ask('feature', [running('review')]), 1);
});

test('review, gate and build are accepted kinds and an unknown one is not', () => {
  const db = openDb(tmpDb());
  for (const kind of ['review', 'gate', 'build']) {
    assert.equal(jobs.enqueue(db, { project: 'a', kind, key: 'k', priority: 1, slots: 1 }, HOURS).created, true);
  }
  assert.throws(() => jobs.enqueue(db, { project: 'a', kind: 'shell', key: 'k', priority: 1, slots: 1 }, HOURS), /kind/);
});

test('two builds queued: the second is claimed only when the first ends, agents are claimed meanwhile', () => {
  const db = openDb(tmpDb());
  for (const [kind, key] of [['build', '1'], ['gate', '2'], ['bug', '3']]) jobs.enqueue(db, { project: 'a', kind, key, priority: 1, slots: 1 }, HOURS);
  const claim = () => jobs.claimNext(db, { projects: new Set(['a']), limits, now: HOURS });
  const first = claim();
  assert.equal(first.kind, 'build');
  assert.equal(claim().kind, 'bug');
  assert.equal(claim(), null);
  jobs.finish(db, first.id, 'done', {}, HOURS);
  assert.equal(claim().kind, 'gate');
});

test('an older database keeps its jobs and ids, and takes the new kinds', () => {
  const file = tmpDb();
  const raw = new DatabaseSync(file);
  for (const sql of MIGRATIONS.slice(0, 3)) raw.exec(sql);
  raw.exec("INSERT INTO jobs (id, project, kind, key, priority, slots, created_at, session_id, pid_start) VALUES (41, 'a', 'bug', 'K-1', 1, 1, 5, 's', 'Wed Nov 25')");
  raw.exec('PRAGMA user_version = 3');
  raw.close();
  const db = openDb(file);
  const old = jobs.getJob(db, 41);
  assert.deepEqual([old.kind, old.sessionId, old.pidStart, old.state], ['bug', 's', 'Wed Nov 25', 'queued']);
  assert.equal(jobs.enqueue(db, { project: 'a', kind: 'gate', key: 'g', priority: 1, slots: 1 }, HOURS).id, 42);
  assert.equal(jobs.enqueue(db, { project: 'a', kind: 'bug', key: 'K-1', priority: 1, slots: 1 }, HOURS).id, 41);
});
