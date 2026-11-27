const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const polling = require('../src/bugs/polling.cjs');
const board = require('../src/board/store.cjs');
const { boardStep, boardJql } = require('../src/board/sync.cjs');
const { setup, NOW, MIN } = require('./bugs-step-fixtures.cjs');

const LOOP_JQL = 'project = ABC1 AND issuetype = Bug AND status in ("To Do", "Reopened")\nAND (labels is EMPTY OR labels not in ("human-only")) AND created <= -2m\nAND ((created >= "2026-11-26 09:00" AND (fixVersion is EMPTY OR fixVersion in ("1.9.2", "1.9.2-hotfix"))) OR fixVersion in ("1.9.2", "1.9.2-hotfix") OR labels = "claude-fix" OR status changed to Reopened after "2026-11-26 09:00" AND (fixVersion is EMPTY OR fixVersion in ("1.9.2", "1.9.2-hotfix")))\nORDER BY priority DESC, created ASC';

const bug = (status, priority = 'High', extra = {}) => ({ status, priority, summary: `bug ${status}`, ...extra });

function world(t, issues, options = {}) {
  const s = setup(t, { issues, ...options });
  s.run = async (at = NOW) => {
    await boardStep(s.ctx, s.config(), at);
    await s.ctx.boardStepPending;
  };
  s.boardSearches = () => s.fake.calls.filter(call => call.name === 'jira_search' && /ORDER BY priority DESC, updated DESC/.test(call.args.jql));
  return s;
}

test('the bug loop jql is unchanged', () => {
  assert.equal(polling.jql('ABC1', '1.9.2', NOW, { waiting: ['To Do', 'Reopened'], baselineAt: NOW - 60 * MIN, fixVersions: ['1.9.2', '1.9.2-hotfix'] }), LOOP_JQL);
});

test('the board jql takes every status of the version scope', () => {
  const text = boardJql('ABC1', { baselineAt: NOW - 60 * MIN, fixVersions: ['1.9.2'] });
  assert.equal(text, 'project = ABC1 AND issuetype = Bug AND ((created >= "2026-11-26 09:00" AND (fixVersion is EMPTY OR fixVersion in ("1.9.2"))) OR fixVersion in ("1.9.2"))\nORDER BY priority DESC, updated DESC');
  assert.doesNotMatch(boardJql('ABC1', { baselineAt: NOW, fixVersions: [] }), /status/);
});

test('sync stores every bug of a tracked version with its real Jira status', async t => {
  const s = world(t, { 'ABC1-1': bug('To Do'), 'ABC1-2': bug('In Progress', 'Medium', { assignee: { displayName: 'Lan' } }), 'ABC1-3': bug('Done', 'Low') });
  s.turnOn();
  await s.run();
  const rows = board.bugsOf(s.ctx.db, 'ABC1');
  assert.deepEqual(rows.map(row => [row.version, row.key, row.status, row.priority, row.assignee]), [
    ['1.9.2', 'ABC1-1', 'To Do', 'High', null], ['1.9.2', 'ABC1-2', 'In Progress', 'Medium', 'Lan'], ['1.9.2', 'ABC1-3', 'Done', 'Low', null],
  ]);
  assert.deepEqual(board.syncOf(s.ctx.db, 'ABC1', '1.9.2'), { at: NOW, ok: true, count: 3, capped: false });
});

test('sync replaces the rows of a version and drops bugs that left the scope', async t => {
  const s = world(t, { 'ABC1-1': bug('To Do'), 'ABC1-2': bug('In Progress') });
  s.turnOn();
  await s.run();
  delete s.fake.issues['ABC1-1'];
  s.fake.issues['ABC1-2'].status = 'Resolved';
  await s.run(NOW + 16 * MIN);
  assert.deepEqual(board.bugsOf(s.ctx.db, 'ABC1').map(row => [row.key, row.status]), [['ABC1-2', 'Resolved']]);
});

test('sync runs at most every 15 minutes per version and only for open tracked versions', async t => {
  const s = world(t, { 'ABC1-1': bug('To Do') });
  await s.run();
  assert.equal(s.boardSearches().length, 0);
  s.turnOn();
  await s.run();
  await s.run(NOW + 10 * MIN);
  assert.equal(s.boardSearches().length, 1);
  await s.run(NOW + 16 * MIN);
  assert.equal(s.boardSearches().length, 2);
  polling.setPolling(s.ctx.db, 'ABC1', '1.9.2', false, NOW + 17 * MIN);
  await s.run(NOW + 40 * MIN);
  assert.equal(s.boardSearches().length, 2);
});

test('a Jira error keeps the old rows, records the error and the last good time, and the tick goes on', async t => {
  const s = world(t, { 'ABC1-1': bug('To Do') });
  s.turnOn();
  await s.run();
  s.ctx.bugs.jira = async () => ({ search: async () => { throw new Error('Jira 503\nchi tiết'); } });
  await assert.doesNotReject(s.run(NOW + 16 * MIN));
  assert.deepEqual(board.bugsOf(s.ctx.db, 'ABC1').map(row => row.key), ['ABC1-1']);
  assert.deepEqual(board.syncOf(s.ctx.db, 'ABC1', '1.9.2'), { at: NOW + 16 * MIN, ok: false, error: 'Jira 503', lastOkAt: NOW });
  assert.equal(kv.get(s.ctx.db, 'board-sync:ABC1:1.9.2').ok, false);
});

test('sync only calls jira_search and works when the project is not live', async t => {
  const s = world(t, { 'ABC1-1': bug('To Do') }, { live: false });
  s.turnOn();
  await s.run();
  assert.ok(s.fake.calls.length > 0);
  assert.deepEqual([...new Set(s.fake.calls.map(call => call.name))], ['jira_search']);
  assert.equal(board.bugsOf(s.ctx.db, 'ABC1').length, 1);
});
