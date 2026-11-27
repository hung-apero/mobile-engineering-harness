const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { intake, priorityOf } = require('../src/bugs/intake.cjs');
const store = require('../src/bugs/store.cjs');
const { DEFAULT_FORBIDDEN } = require('../src/bugs/diff-guard.cjs');
const { createJira, JiraError } = require('../src/bugs/jira.cjs');
const { createFakeJira } = require('./fixtures/fake-jira.cjs');

const memDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-fixb-')), 'dz.db'));
const issue = (extra = {}) => ({ key: 'ABC1-1', status: 'To Do', priority: 'High', summary: 'x', labels: [], commentCount: 0, attachmentCount: 0, ...extra });
const run = (db, issues, now) => intake(db, { project: 'ABC1', version: '1.9.2', issues, now, reopenLimit: 3 });

test('I5: a done ticket still Reopened with the same fingerprint is not accepted again, a changed one is', () => {
  const db = memDb();
  store.ensureVersion(db, { project: 'ABC1', version: '1.9.2' });
  assert.deepEqual(run(db, [issue({ status: 'Reopened' })], 1).accepted, ['ABC1-1']);
  db.prepare("UPDATE tickets SET state = 'done'").run();
  assert.deepEqual(run(db, [issue({ status: 'Reopened' })], 2).accepted, []);
  assert.deepEqual(run(db, [issue({ status: 'Reopened', commentCount: 1 })], 3).accepted, ['ABC1-1']);
});

test('crash and anr match whole words only', () => {
  assert.equal(priorityOf(issue({ priority: 'Low', summary: 'App crash on start' })), 0);
  assert.equal(priorityOf(issue({ priority: 'Low', summary: 'ANR in splash' })), 0);
  assert.equal(priorityOf(issue({ priority: 'Low', summary: 'Banner text transparent, planRate wrong' })), 3);
  assert.equal(priorityOf(issue({ priority: 'Low', summary: 'crashlytics label missing' })), 3);
});

test('the default forbidden globs cover agent config and the gradle wrapper scripts', () => {
  for (const glob of ['**/CLAUDE.md', '**/AGENTS.md', '**/.mcp.json', '**/gradlew', '**/gradlew.bat']) assert.ok(DEFAULT_FORBIDDEN.includes(glob), glob);
});

const jiraWith = (pages, calls = []) => createJira({
  configFile: '/x', live: true, record() {}, timeoutMs: 50,
  connect: async () => ({ callTool: async ({ arguments: a }) => { calls.push(a); const p = pages(a); return { content: [{ type: 'text', text: JSON.stringify(p) }] }; }, close() {} }),
});

test('I8: search throws JiraError when a page has no issues array', async () => {
  await assert.rejects(jiraWith(() => ({ total: 3 })).search('x'), JiraError);
  await assert.rejects(jiraWith(() => ({ issues: 'nope', total: 3 })).search('x'), JiraError);
});

test('I8: total -1 is fine for a short page and a JiraError for a full page', async () => {
  const keys = n => Array.from({ length: n }, (_, i) => ({ key: `ABC1-${i + 1}` }));
  assert.equal((await jiraWith(() => ({ total: -1, issues: keys(3) })).search('x')).length, 3);
  await assert.rejects(jiraWith(() => ({ total: -1, issues: keys(50) })).search('x'), JiraError);
});
