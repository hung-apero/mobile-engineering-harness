const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { fixVersionNames } = require('../src/bugs/fix-versions.cjs');
const { assess, checkRelease, releaseKey, INTERVAL_MS } = require('../src/bugs/release.cjs');
const { memDb, t } = require('./bugs-fixtures.cjs');

const NOW = t('2026-11-26T10:00');
const MIN = 60000;
const project = { key: 'AAP1', jiraStatus: { waiting: ['To Do'], inProgress: 'In Progress', resolved: 'Resolved', reopened: 'Reopened', done: ['Closed'] } };
const REAL = "jira_search: Error calling tool 'jira_search': Error searching issues: The value '1.9.2' does not exist for the field 'fixVersion'.";

function setup() {
  const db = memDb();
  store.ensureVersion(db, { project: 'AAP1', version: '1.9.2' });
  const s = { db, failure: null, calls: [] };
  s.jira = {
    search: async jql => {
      s.calls.push(jql);
      if (s.failure) throw new Error(s.failure);
      return [];
    },
  };
  s.ctx = { db, dzHome: '/x', rulesFor: () => ({ version: 'v1' }), bugs: { jira: async () => s.jira, baseContains: async () => ({ ok: false, detail: 'x' }) } };
  s.ctx.bugs.versionTip = async () => ({ sha: 'b'.repeat(40), tree: 'a'.repeat(40) });
  kv.set(db, 'e2e:AAP1:1.9.2', { result: { tree: 'a'.repeat(40), status: 'pass', failures: [], incomplete: [] } }, NOW);
  s.version = store.getVersion(db, 'AAP1', '1.9.2');
  s.names = now => fixVersionNames(s.ctx, project, s.jira, '1.9.2', now);
  return s;
}

for (const text of [
  '401 Unauthorized', '403 Forbidden: fixVersion', 'invalid token', "The value 'AAP1' does not exist for the field 'project'.",
  "Field 'fixVersion' does not exist or you do not have permission to view it.", 'unknown version',
]) {
  test(`N2: "${text}" is an error, not a missing version`, async () => {
    const s = setup();
    s.failure = text;
    await assert.rejects(s.names(NOW), new RegExp(text.slice(0, 12)));
    assert.equal(kv.get(s.db, 'bug-fixver-exists:AAP1:1.9.2'), null);
  });
}

test('N2: a missing version is believed for at most 10 minutes, an existing one for a day', async () => {
  const s = setup();
  s.failure = REAL;
  assert.deepEqual(await s.names(NOW), []);
  s.failure = null;
  assert.deepEqual(await s.names(NOW + 9 * MIN), []);
  assert.deepEqual(await s.names(NOW + 10 * MIN), ['1.9.2']);
  await s.names(NOW + 20 * MIN);
  assert.equal(s.calls.length, 2);
});

test('N2: a failed probe makes the release assessment unknown and leaves the release waits alone', async () => {
  const s = setup();
  assert.equal((await checkRelease(s.ctx, project, s.version, NOW)).ready, 'merge');
  kv.del(s.db, 'bug-fixver-exists:AAP1:1.9.2');
  s.failure = '401 Unauthorized';
  const result = await assess(s.ctx, project, s.version, NOW);
  assert.deepEqual(result.conditions.map(c => c.ok), [false, null, null, null, true, true]);
  assert.equal(result.ready, 'none');
  await checkRelease(s.ctx, project, s.version, NOW + INTERVAL_MS);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM waits WHERE state = 'open'").get().n, 1);
  const saved = kv.get(s.db, releaseKey('AAP1', '1.9.2'));
  assert.equal(saved.ready, 'merge');
  assert.deepEqual(saved.flags, [false, null, null, null, true, true]);
  s.failure = null;
  await checkRelease(s.ctx, project, s.version, NOW + 2 * INTERVAL_MS);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE code = 'R01'").get().n, 1);
});
