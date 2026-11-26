const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, MIGRATIONS } = require('../src/db.cjs');
const { memDb } = require('./bugs-fixtures.cjs');
const { once, markOnce, getEffect, effectId, recordWould } = require('../src/bugs/effects.cjs');

test('a done effect returns its stored result without calling again', async () => {
  const db = memDb();
  let calls = 0;
  const fn = async () => ({ n: ++calls });
  assert.deepEqual(await once(db, '7:AAP1-1:claim', fn, 5), { n: 1 });
  assert.deepEqual(await once(db, '7:AAP1-1:claim', fn, 6), { n: 1 });
  assert.equal(calls, 1);
  assert.deepEqual({ ...db.prepare('SELECT * FROM effects').get() }, { id: '7:AAP1-1:claim', batch_id: 7, state: 'done', result: '{"n":1}', at: 5 });
});

test('a failed effect keeps its intention and is called again', async () => {
  const db = memDb();
  await assert.rejects(once(db, '7:-:push', async () => { throw new Error('x'); }));
  assert.equal(getEffect(db, '7:-:push').state, 'started');
  assert.equal(await once(db, '7:-:push', async () => 'ok'), 'ok');
});

test('the intention is on disk before the call', async () => {
  const db = memDb();
  await once(db, '7:-:push', async () => assert.equal(getEffect(db, '7:-:push').state, 'started'));
});

test('dry and live results do not mix', async () => {
  const db = memDb();
  await once(db, effectId(7, null, 'push', false), async () => 'dry');
  assert.equal(await once(db, effectId(7, null, 'push', true), async () => 'live'), 'live');
  assert.equal(effectId(7, null, 'push', false), 'dry:7:-:push');
});

test('markOnce runs once in a transaction and rolls back on error', () => {
  const db = memDb();
  assert.throws(() => markOnce(db, '1:-:a', () => { throw new Error('x'); }));
  assert.equal(getEffect(db, '1:-:a'), null);
  assert.deepEqual(markOnce(db, '1:-:a', () => 3), { first: true, result: 3 });
  assert.deepEqual(markOnce(db, '1:-:a', () => 4), { first: false, result: 3 });
});

test('a malformed effect id is refused', async () => {
  const db = memDb();
  await assert.rejects(once(db, 'x:-:a', async () => 1));
});

test('recordWould writes a would decision with the batch id', () => {
  const db = memDb();
  const ctx = { db, rulesFor: () => ({ version: 'v1' }), now: () => 9 };
  recordWould(ctx, { key: 'AAP1' }, { id: 4 })('would', 'git push x');
  recordWould(ctx, { key: 'AAP1' })('would', 'jira y');
  const rows = db.prepare('SELECT project, action, evidence, at, rule_version FROM decisions ORDER BY id').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [
    { project: 'AAP1', action: 'would', evidence: '{"text":"git push x","batchId":4}', at: 9, rule_version: 'v1' },
    { project: 'AAP1', action: 'would', evidence: '{"text":"jira y","batchId":null}', at: 9, rule_version: 'v1' },
  ]);
});

test('a database at any earlier version gets the effects table', () => {
  for (let version = 0; version <= MIGRATIONS.length; version++) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-mig-')), 'dz.db');
    const raw = new DatabaseSync(file);
    for (const sql of MIGRATIONS.slice(0, version)) raw.exec(sql);
    raw.exec(`PRAGMA user_version = ${version}`);
    raw.close();
    const db = openDb(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
    markOnce(db, '1:-:a', () => 1);
    db.close();
  }
});
