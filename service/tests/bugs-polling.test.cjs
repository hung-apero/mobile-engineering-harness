const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/bugs/store.cjs');
const polling = require('../src/bugs/polling.cjs');
const { t, HOUR, memDb } = require('./bugs-fixtures.cjs');

const NOW = t('2026-11-25T10:00:00');
const MIN = 60 * 1000;
const waiting = ['Request', 'To Do', 'Reopened'];

test('jql has exactly the section 7 shape with Saigon times and the fixVersion clause', () => {
  const text = polling.jql('AAP864', '1.2.0', NOW, { waiting, baselineAt: t('2026-11-24T08:30:00'), fixVersions: ['1.2.0'] });
  assert.equal(text, [
    'project = AAP864 AND issuetype = Bug AND status in ("Request", "To Do", "Reopened")',
    'AND (labels is EMPTY OR labels not in ("human-only")) AND created <= -2m',
    'AND ((created >= "2026-11-24 08:30" AND (fixVersion is EMPTY OR fixVersion in ("1.2.0"))) OR fixVersion in ("1.2.0") OR labels = "claude-fix" OR status changed to Reopened after "2026-11-24 08:30" AND (fixVersion is EMPTY OR fixVersion in ("1.2.0")))',
    'ORDER BY priority DESC, created ASC',
  ].join('\n'));
});

test('jql drops the fixVersion clause when the version is not on Jira and adds the key filter when asked', () => {
  const text = polling.jql('AAP864', '1.2.0', NOW, { waiting, keys: ['AAP864-1', 'AAP864-2'] });
  assert.ok(!text.includes('fixVersion in'));
  assert.ok(text.includes('(created >= "2026-11-25 10:00" AND fixVersion is EMPTY)'));
  assert.ok(text.includes('\nAND key in (AAP864-1, AAP864-2)\nORDER BY'));
});

test('jql rejects every unsafe inserted value', () => {
  const bad = (project, version, options = {}) => assert.throws(() => polling.jql(project, version, NOW, { waiting, ...options }));
  bad('AAP864 OR 1=1', '1.0');
  bad('AAP864', '1.0" OR "a"="a');
  bad('AAP864', '-1');
  bad('AAP864', '1.0', { waiting: ['To Do", "x'] });
  bad('AAP864', '1.0', { waiting: ['a\\b'] });
  bad('AAP864', '1.0', { waiting: ['a\nb'] });
  bad('AAP864', '1.0', { waiting: [] });
  bad('AAP864', '1.0', { keys: ['AAP864-1) OR (1=1'] });
  bad('AAP864', '1.0', { baselineAt: NaN });
});

test('polling is off by default and sending the first build turns it on with that baseline; later builds keep it', () => {
  const db = memDb();
  assert.equal(store.getVersion(db, 'AAP', '1.0'), null);
  const first = polling.recordBuildSent(db, 'AAP', '1.0', NOW);
  assert.equal(first.polling, true);
  assert.equal(first.baselineAt, NOW);
  const second = polling.recordBuildSent(db, 'AAP', '1.0', NOW + 5 * HOUR);
  assert.equal(second.baselineAt, NOW);
  assert.equal(polling.pollInterval(store.ensureVersion(db, { project: 'AAP', version: '2.0' }), NOW), null);
});

test('pollInterval is 3 minutes, then 15 minutes after 24 hours without a new bug', () => {
  const db = memDb();
  const version = polling.recordBuildSent(db, 'AAP', '1.0', NOW);
  assert.equal(polling.pollInterval(version, NOW + 23 * HOUR), 3 * MIN);
  assert.equal(polling.pollInterval(version, NOW + 24 * HOUR), 15 * MIN);
  const fresh = polling.recordPoll(db, 'AAP', '1.0', { newCount: 2, now: NOW + 30 * HOUR });
  assert.equal(polling.pollInterval(fresh, NOW + 31 * HOUR), 3 * MIN);
  assert.equal(polling.pollInterval(fresh, NOW + 30 * HOUR + 24 * HOUR, 24), 15 * MIN);
  assert.equal(polling.pollInterval(fresh, NOW + 30 * HOUR + 12 * HOUR, 6), 15 * MIN);
});

test('recordPoll updates last_poll_at always and last_new_at only when new bugs came; ignored while polling is off', () => {
  const db = memDb();
  polling.recordBuildSent(db, 'AAP', '1.0', NOW);
  const none = polling.recordPoll(db, 'AAP', '1.0', { newCount: 0, now: NOW + MIN });
  assert.equal(none.lastPollAt, NOW + MIN);
  assert.equal(none.lastNewAt, null);
  const some = polling.recordPoll(db, 'AAP', '1.0', { newCount: 1, now: NOW + 2 * MIN });
  assert.equal(some.lastNewAt, NOW + 2 * MIN);
  polling.setPolling(db, 'AAP', '1.0', false, NOW + 3 * MIN);
  const off = polling.recordPoll(db, 'AAP', '1.0', { newCount: 5, now: NOW + 4 * MIN });
  assert.equal(off.lastPollAt, NOW + 2 * MIN);
  assert.equal(polling.pollInterval(off, NOW + 5 * MIN), null);
});

test('setPolling needs an existing version, keeps the baseline and sets one when turned on by hand', () => {
  const db = memDb();
  assert.throws(() => polling.setPolling(db, 'AAP', '1.0', true, NOW));
  store.ensureVersion(db, { project: 'AAP', version: '1.0' });
  const on = polling.setPolling(db, 'AAP', '1.0', true, NOW);
  assert.equal(on.polling, true);
  assert.equal(on.baselineAt, NOW);
  const off = polling.setPolling(db, 'AAP', '1.0', false, NOW + HOUR);
  assert.equal(off.polling, false);
  assert.equal(off.baselineAt, NOW);
  assert.equal(polling.setPolling(db, 'AAP', '1.0', true, NOW + 2 * HOUR).baselineAt, NOW);
});
