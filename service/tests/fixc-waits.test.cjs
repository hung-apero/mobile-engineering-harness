const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { openWait } = require('../src/pings.cjs');
const { bugStep } = require('../src/bugs/step.cjs');
const { setup, issue, NOW, MIN } = require('./bugs-step-fixtures.cjs');
const { setup: machine } = require('./bugs-machine-fixtures.cjs');

const state = (ctx, id) => ctx.db.prepare('SELECT state FROM waits WHERE id = ?').get(id).state;
const wait = (ctx, role, subject) => openWait(ctx.db, { project: 'ABC1', role, subject }, NOW - 60 * MIN);

function ticketWait(s, status) {
  const id = wait(s.ctx, 'po', 'PO trả lời ABC1-1: gì?');
  kv.set(s.ctx.db, 'bug-waits:ABC1:ABC1-1', [id], NOW);
  if (status) kv.set(s.ctx.db, 'bug-wait-status:ABC1:ABC1-1', { [id]: status }, NOW);
  return id;
}

for (const [from, to, expected] of [
  ['To Do', 'In Progress', 'open'],
  ['In Progress', 'In Progress', 'open'],
  ['To Do', 'To Do', 'open'],
  [null, 'In Review', 'open'],
  ['To Do', 'In Review', 'resolved'],
  ['In Progress', 'To Do', 'resolved'],
  [null, 'Closed', 'resolved'],
  [null, 'Done', 'resolved'],
]) {
  test(`N1: a ticket wait opened at ${from} is ${expected} once Jira says ${to}`, async t => {
    const s = setup(t, { issues: { 'ABC1-1': issue(to) } });
    s.turnOn();
    const id = ticketWait(s, from);
    await bugStep(s.ctx, s.config(), NOW);
    assert.equal(state(s.ctx, id), expected);
  });
}

test('N1: resolved closes a ticket wait although it is not listed in done', async t => {
  const jiraStatus = { waiting: ['To Do'], inProgress: 'In Progress', resolved: 'Resolved', reopened: 'Reopened', done: ['Closed'] };
  const s = setup(t, { issues: { 'ABC1-1': issue('resolved') } });
  s.h.project('ABC1', { jiraStatus });
  s.turnOn();
  const id = ticketWait(s, null);
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, id), 'resolved');
});

test('N1: a conclusion records the Jira status its wait was opened at, and a new claim forgets it', async t => {
  const kinds = { ticket: key => ({ key, verdict: 'not-a-bug', status: 'skipped', rootCause: 'đúng spec' }) };
  const s = machine(t, { kinds });
  await s.until(await s.open());
  const [{ id }] = s.rows("SELECT id FROM waits WHERE state = 'open'");
  assert.deepEqual(kv.get(s.db, 'bug-wait-status:AAP1:AAP1-1'), { [id]: 'To Do' });
  s.fake.issues['AAP1-1'].comments.push('QA: vẫn lỗi');
  await s.until(await s.open(), s.kindsOf('fixing'));
  assert.equal(kv.get(s.db, 'bug-wait-status:AAP1:AAP1-1'), null);
});

const deliver = (ctx, key, version = '1.9.2') => ctx.db.prepare("INSERT INTO tickets (project, key, version, priority, state, verdict, fingerprint, updated_at) VALUES ('ABC1', ?, ?, 1, 'done', 'fixed', 'x', 1)").run(key, version);

test('N6: a Kiểm bản cài wait depends only on the tickets this service delivered for the version', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue('Done'), 'ABC1-2': issue('Done'), 'ABC1-3': issue('Done') } });
  store.ensureVersion(s.ctx.db, { project: 'ABC1', version: '1.9.2' });
  deliver(s.ctx, 'ABC1-1');
  deliver(s.ctx, 'ABC1-2', '1.9.3');
  const id = wait(s.ctx, 'qa', 'Kiểm bản cài ABC1 1.9.2');
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, id), 'open');
  s.fake.issues['ABC1-1'].status = 'Closed';
  await bugStep(s.ctx, s.config(), NOW + 6 * MIN);
  assert.equal(state(s.ctx, id), 'resolved');
});

test('N6: a delivered ticket Jira will not show keeps the Kiểm bản cài wait open', async t => {
  const s = setup(t);
  s.turnOn();
  deliver(s.ctx, 'ABC1-404');
  const id = wait(s.ctx, 'qa', 'Kiểm bản cài ABC1 1.9.2');
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, id), 'open');
});

test('a Merge PR wait of another version with the same prefix is left alone', async t => {
  const s = setup(t);
  s.turnOn();
  s.turnOn('ABC1', '1.9.20');
  const short = wait(s.ctx, 'dev', 'Merge PR dz/release-1.9.2 (quá 800 dòng)');
  const long = wait(s.ctx, 'dev', 'Merge PR dz/release-1.9.20 (quá 800 dòng)');
  s.ctx.bugs.baseContains = async (_, __, version) => ({ ok: version.version === '1.9.2', detail: 'x' });
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, short), 'resolved');
  assert.equal(state(s.ctx, long), 'open');
});

test('waits opened in dry-run are not pinged by a live project whose claim is refused', async t => {
  const { tick } = require('../src/tick.cjs');
  const { makeHome } = require('./service-fixtures.cjs');
  const h = makeHome(t);
  h.project('ABC1', { live: true });
  h.webhook('ABC1');
  const ctx = h.context();
  const sent = [];
  ctx.send = async message => { sent.push(message); return { ok: true }; };
  const at = Date.parse('2026-11-25T10:00:00+07:00');
  const open = subject => openWait(ctx.db, { project: 'ABC1', role: 'dev', subject }, at - 3 * 24 * 60 * MIN);
  const dry = open('việc lúc chạy khô');
  kv.set(ctx.db, 'bug-dry-waits:ABC1:1.9.2', [dry], at);
  open('ABC1 1.9.2: chưa chạy live được');
  await tick(ctx, at);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /chưa chạy live được/);
  assert.doesNotMatch(sent[0].content, /việc lúc chạy khô/);
  assert.equal(ctx.db.prepare('SELECT ping_count FROM waits WHERE id = ?').get(dry).ping_count, 0);
});
