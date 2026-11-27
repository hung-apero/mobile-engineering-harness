const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS } = require('../src/db.cjs');
const store = require('../src/bugs/store.cjs');
const { intake, planBatches } = require('../src/bugs/intake.cjs');
const { t, memDb, issue } = require('./bugs-fixtures.cjs');

const NOW = t('2026-11-25T10:00:00');

test('migration creates versions, tickets and batches and keeps earlier tables', () => {
  const mem = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS) mem.exec(sql);
  const names = mem.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
  for (const name of ['jobs', 'kv', 'versions', 'tickets', 'batches']) assert.ok(names.includes(name), name);
  const cols = table => mem.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  assert.deepEqual(cols('versions'), ['project', 'version', 'branch', 'state', 'baseline_at', 'polling', 'last_new_at', 'last_poll_at', 'build_failures']);
  assert.deepEqual(cols('tickets'), ['project', 'key', 'version', 'priority', 'state', 'verdict', 'batch_id', 'reopen_count', 'fingerprint', 'updated_at']);
  assert.deepEqual(cols('batches'), ['id', 'project', 'version', 'kind', 'state', 'keys', 'data', 'opened_at', 'updated_at']);
});

test('ensureVersion is idempotent, defaults the branch and rejects a bad version', () => {
  const db = memDb();
  const a = store.ensureVersion(db, { project: 'AAP', version: '1.2.0' });
  const b = store.ensureVersion(db, { project: 'AAP', version: '1.2.0', branch: 'other' });
  assert.equal(a.branch, 'dz/release-1.2.0');
  assert.deepEqual(b, a);
  assert.equal(a.polling, false);
  assert.throws(() => store.ensureVersion(db, { project: 'AAP', version: '1.0"' }));
});

test('setVerdict is guarded: only a ticket still in the queue can get a verdict', () => {
  const db = memDb();
  store.ensureVersion(db, { project: 'AAP', version: '1.0' });
  intake(db, { project: 'AAP', version: '1.0', issues: [issue('AAP-1')], now: NOW });
  const ticket = store.setVerdict(db, 'AAP', 'AAP-1', 'not-a-bug', NOW + 1);
  assert.equal(ticket.state, 'concluded');
  assert.equal(ticket.verdict, 'not-a-bug');
  assert.throws(() => store.setVerdict(db, 'AAP', 'AAP-9', 'x', NOW));
  assert.equal(store.setTicketState(db, 'AAP', 'AAP-1', 'accepted', 'done', NOW), false);
  assert.equal(store.setTicketState(db, 'AAP', 'AAP-1', 'concluded', 'done', NOW), true);
});

test('transitionBatch only moves from the expected state and frees unfinished tickets when a batch ends', () => {
  const db = memDb();
  store.ensureVersion(db, { project: 'AAP', version: '1.0' });
  intake(db, { project: 'AAP', version: '1.0', issues: [issue('AAP-1', { priority: 'Highest' })], now: NOW });
  const [batch] = planBatches(db, 'AAP', NOW);
  assert.equal(store.transitionBatch(db, batch.id, 'running', 'done', NOW), null);
  assert.equal(store.transitionBatch(db, batch.id, 'open', 'running', NOW, { lane: 1 }).data.lane, 1);
  store.transitionBatch(db, batch.id, 'running', 'abandoned', NOW + 1);
  const ticket = store.getTicket(db, 'AAP', 'AAP-1');
  assert.equal(ticket.state, 'accepted');
  assert.equal(ticket.batchId, null);
});
