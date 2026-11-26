const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { openWait } = require('../src/pings.cjs');
const { bugStep } = require('../src/bugs/step.cjs');
const { createContext } = require('../src/context.cjs');
const { setup, issue, NOW, MIN } = require('./bugs-step-fixtures.cjs');

const state = (ctx, id) => ctx.db.prepare('SELECT state FROM waits WHERE id = ?').get(id).state;
const wait = (ctx, role, subject) => openWait(ctx.db, { project: 'ABC1', role, subject }, NOW - 60 * MIN);

test('I4: a ticket wait closes when the ticket moves away from its status, and stays while it waits', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue('To Do'), 'ABC1-2': issue('To Do') } });
  s.turnOn();
  const stays = wait(s.ctx, 'po', 'PO trả lời ABC1-1: gì?');
  const goes = wait(s.ctx, 'qa', 'QA xem lại ABC1-2: gì?');
  kv.set(s.ctx.db, 'bug-waits:ABC1:ABC1-1', [stays], NOW);
  kv.set(s.ctx.db, 'bug-waits:ABC1:ABC1-2', [goes], NOW);
  kv.set(s.ctx.db, 'bug-wait-status:ABC1:ABC1-2', { [goes]: 'To Do' }, NOW);
  s.fake.issues['ABC1-2'].status = 'In Review';
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, stays), 'open');
  assert.equal(state(s.ctx, goes), 'resolved');
});

test('I4: a ticket wait closes when the ticket is closed', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue('Closed') } });
  s.turnOn();
  const id = wait(s.ctx, 'dev', 'ABC1-1: lý do');
  kv.set(s.ctx.db, 'bug-waits:ABC1:ABC1-1', [id], NOW);
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, id), 'resolved');
});

test('I4: a ticket Jira refuses does not stop the other waits from closing', async t => {
  const s = setup(t, { issues: { 'ABC1-2': issue('Closed') } });
  s.turnOn();
  const refused = wait(s.ctx, 'dev', 'ABC1-1: lý do');
  const goes = wait(s.ctx, 'dev', 'ABC1-2: lý do');
  kv.set(s.ctx.db, 'bug-waits:ABC1:ABC1-1', [refused], NOW);
  kv.set(s.ctx.db, 'bug-waits:ABC1:ABC1-2', [goes], NOW);
  const jira = await s.ctx.bugs.jira(s.config().projects.get('ABC1'));
  s.ctx.bugs.jira = async () => ({
    ...jira,
    issue: async key => {
      if (key === 'ABC1-1') throw Object.assign(new Error('404 Issue does not exist'), { name: 'JiraError' });
      return jira.issue(key);
    },
  });
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, refused), 'open');
  assert.equal(state(s.ctx, goes), 'resolved');
});

test('I4: a Merge PR wait closes once the base contains the version tip', async t => {
  const s = setup(t);
  s.turnOn();
  const id = wait(s.ctx, 'dev', 'Merge PR dz/release-1.9.2 (quá 800 dòng)');
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, id), 'open');
  s.ctx.bugs.baseContains = async () => ({ ok: true, detail: 'x' });
  await bugStep(s.ctx, s.config(), NOW + 6 * MIN);
  assert.equal(state(s.ctx, id), 'resolved');
});

test('I4: a Kiểm bản cài wait closes when no delivered ticket of the version is still Resolved', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue('Done') } });
  store.ensureVersion(s.ctx.db, { project: 'ABC1', version: '1.9.2' });
  s.ctx.db.prepare("INSERT INTO tickets (project, key, version, priority, state, verdict, fingerprint, updated_at) VALUES ('ABC1', 'ABC1-1', '1.9.2', 1, 'done', 'fixed', 'x', 1)").run();
  const id = wait(s.ctx, 'qa', 'Kiểm bản cài ABC1 1.9.2');
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(state(s.ctx, id), 'open');
  s.fake.issues['ABC1-1'].status = 'Closed';
  await bugStep(s.ctx, s.config(), NOW + 6 * MIN);
  assert.equal(state(s.ctx, id), 'resolved');
});

test('I4: dz waits lists open waits and dz done closes one', t => {
  const s = setup(t);
  const id = wait(s.ctx, 'po', 'PO trả lời ABC1-1: gì?');
  s.ctx.db.close();
  const listed = s.h.dz('waits');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`#${id} .*po.*ABC1.*PO trả lời ABC1-1`));
  assert.equal(s.h.dz('waits', 'ABC1').status, 0);
  assert.equal(s.h.dz('waits', 'abc').status, 2);
  assert.equal(s.h.dz('done').status, 2);
  assert.equal(s.h.dz('done', 'x').status, 2);
  assert.equal(s.h.dz('done', '999').status, 1);
  const closed = s.h.dz('done', String(id));
  assert.equal(closed.status, 0, closed.stderr);
  const ctx = createContext(s.h.env);
  assert.equal(state(ctx, id), 'resolved');
  ctx.db.close();
  assert.doesNotMatch(s.h.dz('waits').stdout, /PO trả lời/);
});
