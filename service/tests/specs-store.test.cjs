const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb, MIGRATIONS } = require('../src/db.cjs');
const jobs = require('../src/jobs.cjs');
const store = require('../src/specs/store.cjs');

const NOW = Date.parse('2026-11-25T10:00:00+07:00');
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-specs-')), 'dz.db');
const make = db => store.createSpec(db, { project: 'AAP1', title: 'Spec A', source: { type: 'confluence', ref: '123' }, figma: 'https://f' }, NOW);

test('createSpec/getSpec/listSpecs round-trip the Spec shape', () => {
  const db = openDb(file());
  const spec = make(db);
  assert.deepEqual(spec, {
    id: spec.id, project: 'AAP1', title: 'Spec A', source: { type: 'confluence', ref: '123' }, figma: 'https://f',
    state: 'new', round: 1, data: {}, specSha: null, approvedSha: null, createdAt: NOW, updatedAt: NOW,
  });
  assert.deepEqual(store.getSpec(db, spec.id), spec);
  assert.equal(store.getSpec(db, 999), null);
  const other = store.createSpec(db, { project: 'BBB', title: 'B', source: {}, figma: null }, NOW);
  assert.deepEqual(store.listSpecs(db).map(s => s.id), [spec.id, other.id]);
  assert.deepEqual(store.listSpecs(db, { project: 'BBB' }).map(s => s.id), [other.id]);
  assert.deepEqual(store.listSpecs(db, { states: ['done'] }), []);
});

test('transitionSpec moves only from the listed states and applies the patch', () => {
  const db = openDb(file());
  const { id } = make(db);
  assert.equal(store.transitionSpec(db, id, ['asking'], 'done', NOW + 1), null);
  assert.equal(store.getSpec(db, id).state, 'new');
  const next = store.transitionSpec(db, id, ['new'], 'asking', NOW + 2, { round: 2, specSha: 'abc', data: { a: 1 } });
  assert.deepEqual([next.state, next.round, next.specSha, next.data, next.updatedAt], ['asking', 2, 'abc', { a: 1 }, NOW + 2]);
  assert.equal(store.transitionSpec(db, id, ['new'], 'done', NOW + 3), null);
  assert.equal(store.patchData(db, id, { b: 2 }, NOW + 4).data.a, 1);
  assert.deepEqual(store.getSpec(db, id).data, { a: 1, b: 2 });
});

test('saveDraft upserts until the round is submitted, then refuses', () => {
  const db = openDb(file());
  const { id } = make(db);
  assert.equal(store.saveDraft(db, { specId: id, qid: 'Q1', round: 1, choice: 'A', text: '', by: 'po' }, NOW), true);
  assert.equal(store.saveDraft(db, { specId: id, qid: 'Q1', round: 1, choice: 'B', text: 'x', by: 'po' }, NOW + 1), true);
  assert.deepEqual(store.answersOf(db, id, 1).map(a => [a.qid, a.choice, a.text]), [['Q1', 'B', 'x']]);
  assert.equal(store.submitRound(db, id, 1, 'po', NOW + 2), true);
  assert.equal(store.saveDraft(db, { specId: id, qid: 'Q1', round: 1, choice: 'A', text: 'ghi đè', by: 'po' }, NOW + 3), false);
  assert.equal(store.saveDraft(db, { specId: id, qid: 'Q2', round: 1, choice: 'A', text: '', by: 'po' }, NOW + 3), false);
  assert.deepEqual(store.answersOf(db, id, 1).map(a => [a.qid, a.choice]), [['Q1', 'B']]);
  assert.equal(store.saveDraft(db, { specId: id, qid: 'Q2', round: 2, choice: 'A', text: '', by: 'po' }, NOW + 4), true);
  assert.deepEqual(store.answersOf(db, id).map(a => [a.round, a.qid]), [[1, 'Q1'], [2, 'Q2']]);
});

test('submitRound succeeds exactly once per round, even over two connections', () => {
  const f = file();
  const a = openDb(f);
  const b = openDb(f);
  const { id } = make(a);
  assert.equal(store.submitRound(a, id, 1, 'tab1', NOW), true);
  assert.equal(store.submitRound(b, id, 1, 'tab2', NOW), false);
  assert.equal(store.submitRound(b, id, 1, 'tab1', NOW), false);
  assert.equal(store.submitRound(b, id, 2, 'tab2', NOW), true);
  assert.equal(a.prepare('SELECT submitted_by FROM spec_rounds WHERE round = 1').get().submitted_by, 'tab1');
});

test('chat questions are added, answered and listed per spec and question', () => {
  const db = openDb(file());
  const { id } = make(db);
  const c1 = store.addChat(db, { specId: id, qid: 'Q1', question: 'Hỏi gì?', by: 'po' }, NOW);
  const c2 = store.addChat(db, { specId: id, qid: 'Q2', question: 'Hai?', by: 'po' }, NOW + 1);
  assert.equal(store.chatsOf(db, id).length, 2);
  assert.equal(store.chatsOf(db, id, 'Q1')[0].state, 'open');
  store.answerChat(db, c1, 'Trả lời', 'answered', NOW + 5);
  assert.deepEqual(store.chatsOf(db, id, 'Q1').map(c => [c.id, c.answer, c.state, c.at]), [[c1, 'Trả lời', 'answered', NOW + 5]]);
  assert.equal(store.chatsOf(db, id, 'Q2')[0].id, c2);
});

test('tokens: sha256 stored, purpose and expiry enforced, revoke removes, guesses fail', () => {
  const db = openDb(file());
  const { id } = make(db);
  const token = store.issueToken(db, { specId: id, purpose: 'quiz', ttlMs: 1000 }, NOW);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM spec_tokens WHERE hash = ?').get(token).n, 0);
  assert.match(db.prepare('SELECT hash FROM spec_tokens').get().hash, /^[0-9a-f]{64}$/);
  assert.equal(store.resolveToken(db, token, 'quiz', NOW + 999), id);
  assert.equal(store.resolveToken(db, token, 'quiz', NOW + 1000), null);
  assert.equal(store.resolveToken(db, token, 'review', NOW), null);
  for (const bad of [undefined, null, '', 'x', token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'), 5]) {
    assert.equal(store.resolveToken(db, bad, 'quiz', NOW), null);
  }
  const review = store.issueToken(db, { specId: id, purpose: 'review', ttlMs: 1000 }, NOW);
  store.revokeTokens(db, id, 'quiz');
  assert.equal(store.resolveToken(db, token, 'quiz', NOW), null);
  assert.equal(store.resolveToken(db, review, 'review', NOW), id);
});

test('migration keeps existing jobs and accepts spec and explain kinds', () => {
  const f = file();
  const db = openDb(f);
  const first = jobs.enqueue(db, { project: 'AAP1', kind: 'bug', key: 'B-1', priority: 1, slots: 1 }, NOW).id;
  db.close();
  const again = openDb(f);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, MIGRATIONS.length);
  assert.equal(jobs.getJob(again, first).key, 'B-1');
  assert.equal(jobs.enqueue(again, { project: 'AAP1', kind: 'spec', key: 's1', priority: 1, slots: 1 }, NOW).created, true);
  assert.equal(jobs.enqueue(again, { project: 'AAP1', kind: 'explain', key: 's1', priority: 1, slots: 1 }, NOW).created, true);
  assert.throws(() => jobs.enqueue(again, { project: 'AAP1', kind: 'nope', key: 'x', priority: 1, slots: 1 }, NOW));
});

test('migrating a database from before the spec tables keeps its jobs', () => {
  const f = file();
  const db = openDb(f);
  const id = jobs.enqueue(db, { project: 'AAP1', kind: 'feature', key: 'F-1', priority: 2, slots: 1 }, NOW).id;
  db.exec('DROP TABLE board_bugs; DROP TABLE viewer_tokens; DROP TABLE inbox; DROP TABLE inbox_posts;');
  db.exec('DROP TABLE spec_tokens; DROP TABLE spec_chat; DROP TABLE spec_rounds; DROP TABLE spec_answers; DROP TABLE specs;');
  db.exec(`PRAGMA user_version = ${MIGRATIONS.findIndex(sql => sql.includes('CREATE TABLE specs'))}`);
  db.exec(`CREATE TABLE jobs_old AS SELECT * FROM jobs`);
  db.close();
  const migrated = openDb(f);
  assert.equal(jobs.getJob(migrated, id).kind, 'feature');
  assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'specs'").get().n, 1);
});
