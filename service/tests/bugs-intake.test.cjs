const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/bugs/store.cjs');
const polling = require('../src/bugs/polling.cjs');
const { intake, planBatches, priorityOf } = require('../src/bugs/intake.cjs');
const { t, HOUR, memDb, issue } = require('./bugs-fixtures.cjs');

const NOW = t('2026-11-25T10:00:00');
const MIN = 60 * 1000;
const run = (db, issues, now = NOW, extra = {}) => intake(db, { project: 'AAP', version: '1.0', issues, now, ...extra });
const setup = () => {
  const db = memDb();
  polling.recordBuildSent(db, 'AAP', '1.0', NOW);
  return db;
};

test('B01 accepts Request, To Do and Reopened tickets, including ones already assigned to a dev', () => {
  const db = setup();
  const out = run(db, [issue('AAP-1', { status: 'Request' }), issue('AAP-2', { assignee: 'dev' }), issue('AAP-3', { status: 'Reopened' })]);
  assert.deepEqual(out.accepted, ['AAP-1', 'AAP-2', 'AAP-3']);
  assert.deepEqual(out.skipped, []);
  assert.equal(store.getTicket(db, 'AAP', 'AAP-2').state, 'accepted');
});

test('B02 skips In Progress and human-only, and takes the ticket again once the dev lets go', () => {
  const db = setup();
  const out = run(db, [issue('AAP-1', { status: 'In Progress' }), issue('AAP-2', { labels: ['human-only'] })]);
  assert.deepEqual(out.accepted, []);
  assert.deepEqual(out.skipped.map(s => [s.key, s.code]), [['AAP-1', 'B02'], ['AAP-2', 'B02']]);
  const again = run(db, [issue('AAP-1')], NOW + MIN);
  assert.deepEqual(again.accepted, ['AAP-1']);
  assert.equal(store.getTicket(db, 'AAP', 'AAP-2').state, 'skipped');
});

test('B02 pulls a still-queued ticket out of the queue when the dev takes it', () => {
  const db = setup();
  run(db, [issue('AAP-1')]);
  run(db, [issue('AAP-1', { status: 'In Progress' })], NOW + MIN);
  assert.equal(store.getTicket(db, 'AAP', 'AAP-1').state, 'skipped');
});

test('B08 a ticket with a verdict is not taken again until its fingerprint changes', () => {
  const db = setup();
  run(db, [issue('AAP-1')]);
  store.setVerdict(db, 'AAP', 'AAP-1', 'needs-info', NOW + 1);
  const quiet = run(db, [issue('AAP-1')], NOW + MIN);
  assert.deepEqual(quiet.accepted, []);
  assert.deepEqual(quiet.skipped.map(s => [s.key, s.code]), [['AAP-1', 'B08']]);
  for (const change of [{ commentCount: 1 }, { attachmentCount: 1 }, { labels: ['claude-fix'] }, { status: 'Request' }]) {
    const fresh = memDb();
    run(fresh, [issue('AAP-1')]);
    store.setVerdict(fresh, 'AAP', 'AAP-1', 'needs-info', NOW + 1);
    assert.deepEqual(run(fresh, [issue('AAP-1', change)], NOW + MIN).accepted, ['AAP-1']);
    assert.equal(store.getTicket(fresh, 'AAP', 'AAP-1').state, 'accepted');
  }
});

test('fingerprint ignores label order and a ticket still in the queue is not reported twice', () => {
  const db = setup();
  run(db, [issue('AAP-1', { labels: ['b', 'a'] })]);
  store.setVerdict(db, 'AAP', 'AAP-1', 'duplicate', NOW + 1);
  assert.deepEqual(run(db, [issue('AAP-1', { labels: ['a', 'b'] })], NOW + MIN).accepted, []);
  run(db, [issue('AAP-2')]);
  assert.deepEqual(run(db, [issue('AAP-2')], NOW + MIN), { accepted: [], skipped: [], giveDev: [] });
});

test('B09 reopen 1 and 2 are accepted for a new batch, reopen 3 goes to the on-call dev once', () => {
  const db = setup();
  run(db, [issue('AAP-1')]);
  for (const n of [1, 2]) {
    store.setTicketState(db, 'AAP', 'AAP-1', n === 1 ? 'accepted' : 'concluded', 'done', NOW);
    const out = run(db, [issue('AAP-1', { status: 'Reopened', commentCount: n })], NOW + n * MIN);
    assert.deepEqual(out.accepted, ['AAP-1']);
    assert.equal(store.getTicket(db, 'AAP', 'AAP-1').reopenCount, n === 1 ? 1 : 2);
    if (n === 1) store.setVerdict(db, 'AAP', 'AAP-1', 'confirmed', NOW + 10);
  }
  store.setTicketState(db, 'AAP', 'AAP-1', 'accepted', 'done', NOW + 20);
  const third = run(db, [issue('AAP-1', { status: 'Reopened', commentCount: 3 })], NOW + 30 * MIN);
  assert.deepEqual(third.giveDev, ['AAP-1']);
  assert.equal(third.skipped[0].code, 'B09');
  assert.equal(store.getTicket(db, 'AAP', 'AAP-1').state, 'dev');
  const later = run(db, [issue('AAP-1', { status: 'Reopened' })], NOW + 40 * MIN);
  assert.deepEqual(later, { accepted: [], skipped: [], giveDev: [] });
});

test('B09 honours a custom reopen limit', () => {
  const db = setup();
  run(db, [issue('AAP-1')]);
  store.setTicketState(db, 'AAP', 'AAP-1', 'accepted', 'done', NOW);
  const out = run(db, [issue('AAP-1', { status: 'Reopened' })], NOW + MIN, { reopenLimit: 1 });
  assert.deepEqual(out.giveDev, ['AAP-1']);
});

test('priority map Highest/High/Medium/Low is 0/1/2/3, unknown is 2, crash and ANR are 0', () => {
  assert.deepEqual(['Highest', 'High', 'Medium', 'Low', 'Weird', undefined].map(p => priorityOf(issue('AAP-1', { priority: p }))), [0, 1, 2, 3, 2, 2]);
  assert.equal(priorityOf(issue('AAP-1', { priority: 'Low', summary: 'App Crash on open' })), 0);
  assert.equal(priorityOf(issue('AAP-1', { priority: 'Low', labels: ['ANR'] })), 0);
});

test('intake is transactional: a bad key rolls back the whole call and rejects a bad version', () => {
  const db = setup();
  assert.throws(() => run(db, [issue('AAP-1'), issue('bad key')]));
  assert.equal(store.getTicket(db, 'AAP', 'AAP-1'), null);
  assert.throws(() => intake(db, { project: 'AAP', version: 'x"', issues: [], now: NOW }));
});

test('B03 a Highest or crash ticket makes its own batch immediately, one at a time, beside a normal batch', () => {
  const db = setup();
  run(db, [issue('AAP-1', { priority: 'Highest' }), issue('AAP-2', { summary: 'crash on start' }), issue('AAP-3')]);
  const first = planBatches(db, 'AAP', NOW);
  assert.deepEqual(first.map(b => [b.kind, b.keys, b.state]), [['highest', ['AAP-1'], 'open']]);
  assert.equal(store.getTicket(db, 'AAP', 'AAP-1').state, 'batched');
  assert.deepEqual(planBatches(db, 'AAP', NOW + MIN), []);
  store.transitionBatch(db, first[0].id, 'open', 'done', NOW + 2 * MIN);
  assert.deepEqual(planBatches(db, 'AAP', NOW + 3 * MIN).map(b => [b.kind, b.keys]), [['highest', ['AAP-2']]]);
});

test('normal tickets wait: not enough, not old enough and queue not drained gives no batch', () => {
  const db = setup();
  run(db, [issue('AAP-1'), issue('AAP-2')]);
  polling.recordPoll(db, 'AAP', '1.0', { newCount: 2, now: NOW });
  assert.deepEqual(planBatches(db, 'AAP', NOW + 3 * HOUR), []);
});

test('a batch closes at max_bugs, and takes the highest priority first', () => {
  const db = setup();
  const issues = [];
  for (let i = 1; i <= 9; i++) issues.push(issue(`AAP-${i}`, { priority: i === 9 ? 'High' : 'Low' }));
  run(db, issues);
  polling.recordPoll(db, 'AAP', '1.0', { newCount: 9, now: NOW });
  const [batch] = planBatches(db, 'AAP', NOW + MIN);
  assert.equal(batch.keys.length, 8);
  assert.equal(batch.keys[0], 'AAP-9');
  assert.equal(store.getTicket(db, 'AAP', 'AAP-8').state, 'accepted');
  assert.deepEqual(planBatches(db, 'AAP', NOW + 2 * MIN), []);
});

test('a batch closes when the oldest accepted ticket has waited max_hours', () => {
  const db = setup();
  run(db, [issue('AAP-1')]);
  polling.recordPoll(db, 'AAP', '1.0', { newCount: 1, now: NOW });
  assert.equal(planBatches(db, 'AAP', NOW + 4 * HOUR - 1).length, 0);
  assert.equal(planBatches(db, 'AAP', NOW + 4 * HOUR).length, 1);
});

test('a batch closes when a poll found nothing new and at least one ticket waits', () => {
  const db = setup();
  run(db, [issue('AAP-1')]);
  polling.recordPoll(db, 'AAP', '1.0', { newCount: 1, now: NOW });
  assert.equal(planBatches(db, 'AAP', NOW + MIN).length, 0);
  polling.recordPoll(db, 'AAP', '1.0', { newCount: 0, now: NOW + 3 * MIN });
  assert.deepEqual(planBatches(db, 'AAP', NOW + 3 * MIN).map(b => b.keys), [['AAP-1']]);
  assert.deepEqual(planBatches(db, 'AAP', NOW + 4 * MIN), []);
});

test('only one non-done normal batch per project and version, and a ticket sits in at most one batch', () => {
  const db = setup();
  run(db, [issue('AAP-1')]);
  polling.recordPoll(db, 'AAP', '1.0', { newCount: 0, now: NOW + MIN });
  const [first] = planBatches(db, 'AAP', NOW + MIN);
  run(db, [issue('AAP-2')], NOW + 2 * MIN);
  polling.recordPoll(db, 'AAP', '1.0', { newCount: 1, now: NOW + 2 * MIN });
  polling.recordPoll(db, 'AAP', '1.0', { newCount: 0, now: NOW + 5 * MIN });
  assert.deepEqual(planBatches(db, 'AAP', NOW + 5 * MIN), []);
  store.transitionBatch(db, first.id, 'open', 'running', NOW + 6 * MIN);
  assert.deepEqual(planBatches(db, 'AAP', NOW + 6 * MIN), []);
  store.setTicketState(db, 'AAP', 'AAP-1', 'batched', 'done', NOW + 7 * MIN);
  store.transitionBatch(db, first.id, 'running', 'done', NOW + 7 * MIN);
  const [second] = planBatches(db, 'AAP', NOW + 7 * MIN);
  assert.deepEqual(second.keys, ['AAP-2']);
  const owners = store.listBatches(db, { project: 'AAP' }).flatMap(b => b.keys);
  assert.equal(new Set(owners).size, owners.length);
});

test('custom limits and other versions are independent', () => {
  const db = setup();
  polling.recordBuildSent(db, 'AAP', '2.0', NOW);
  intake(db, { project: 'AAP', version: '2.0', issues: [issue('AAP-5'), issue('AAP-6')], now: NOW });
  run(db, [issue('AAP-1')]);
  const created = planBatches(db, 'AAP', NOW, { max_bugs: 1, max_hours: 4 });
  assert.deepEqual(created.map(b => [b.version, b.keys.length]), [['1.0', 1], ['2.0', 1]]);
});

test('Q06 quiet polling: 24 hours without a new bug slows polling to 15 minutes', () => {
  const db = setup();
  const row = store.getVersion(db, 'AAP', '1.0');
  assert.equal(polling.pollInterval(row, NOW + 24 * HOUR), 15 * MIN);
});
