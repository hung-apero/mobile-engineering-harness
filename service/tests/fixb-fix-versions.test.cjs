const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const bugCommands = require('../src/bug-commands.cjs');
const store = require('../src/bugs/store.cjs');
const { bugStep, backoffKey } = require('../src/bugs/step.cjs');
const { assess } = require('../src/bugs/release.cjs');
const { setup, NOW, MIN } = require('./bugs-step-fixtures.cjs');
const { memDb } = require('./bugs-fixtures.cjs');

const DAY = 24 * 60 * MIN;
const missing = name => new Error(`The value '${name}' does not exist for the field 'fixVersion'.`);

function jiraStub(ctx, { absent = [], broken = false } = {}) {
  const calls = [];
  ctx.bugs.jira = async () => ({
    search: async jql => {
      calls.push(jql);
      if (broken) throw new Error('Jira 503');
      for (const name of absent) if (jql.includes(`fixVersion = "${name}"`)) throw missing(name);
      return [];
    },
  });
  return calls;
}
const polls = calls => calls.filter(jql => jql.includes('ORDER BY'));
const probes = calls => calls.filter(jql => jql.startsWith('project = ABC1 AND fixVersion = '));

test('B+1: the poll JQL names the version and its --fix-version extras that exist on Jira', async t => {
  const s = setup(t);
  s.turnOn();
  kv.set(s.ctx.db, 'bug-fixver:ABC1:1.9.2', ['1.9.1'], NOW);
  const calls = jiraStub(s.ctx);
  await bugStep(s.ctx, s.config(), NOW);
  const [text] = polls(calls);
  assert.match(text, /fixVersion in \("1\.9\.2", "1\.9\.1"\)/);
  assert.match(text, /\(created >= "[^"]+" AND \(fixVersion is EMPTY OR fixVersion in \("1\.9\.2", "1\.9\.1"\)\)\)/);
});

test('B+1: a version missing on Jira is left out, the probe is cached, and other errors are not read as missing', async t => {
  const s = setup(t);
  s.turnOn();
  kv.set(s.ctx.db, 'bug-fixver:ABC1:1.9.2', ['1.9.1'], NOW);
  const calls = jiraStub(s.ctx, { absent: ['1.9.1'] });
  await bugStep(s.ctx, s.config(), NOW);
  assert.match(polls(calls)[0], /fixVersion in \("1\.9\.2"\)/);
  assert.doesNotMatch(polls(calls)[0], /1\.9\.1/);
  assert.equal(probes(calls).length, 2);
  await bugStep(s.ctx, s.config(), NOW + 3 * MIN);
  assert.equal(probes(calls).length, 2);
  await bugStep(s.ctx, s.config(), NOW + DAY + 4 * MIN);
  assert.equal(probes(calls).length, 4);
});

test('B+1: a Jira outage during the probe is a poll failure, not a missing version', async t => {
  const s = setup(t);
  s.turnOn();
  jiraStub(s.ctx, { broken: true });
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(kv.get(s.ctx.db, backoffKey('ABC1')).failures, 1);
  assert.equal(kv.get(s.ctx.db, 'bug-fixver-exists:ABC1:1.9.2'), null);
});

test('B+1: dz bugs on --fix-version stores the names, validates them and a plain on clears them', async t => {
  const s = setup(t);
  assert.equal(bugCommands.validBugs(['on', 'ABC1', '1.9.2', '--fix-version', '1.9.1,1.9.0']), true);
  for (const bad of [['--fix-version', ''], ['--fix-version', '1.9.1,,1.9.0'], ['--fix-version', 'x y'], ['--fix-version', '1.9.1,1.9.1']]) assert.equal(bugCommands.validBugs(['on', 'ABC1', '1.9.2', ...bad]), false, bad.join(' '));
  await bugCommands.bugs(s.ctx, ['on', 'ABC1', '1.9.2', '--fix-version', '1.9.1,1.9.0'], NOW);
  assert.deepEqual(kv.get(s.ctx.db, 'bug-fixver:ABC1:1.9.2'), ['1.9.1', '1.9.0']);
  await bugCommands.bugs(s.ctx, ['on', 'ABC1', '1.9.2'], NOW);
  assert.equal(kv.get(s.ctx.db, 'bug-fixver:ABC1:1.9.2'), null);
});

test('B+1: dz bugs on without --base sets the baseline to now, never earlier', async t => {
  const s = setup(t);
  await bugCommands.bugs(s.ctx, ['on', 'ABC1', '1.9.2'], NOW);
  assert.equal(store.getVersion(s.ctx.db, 'ABC1', '1.9.2').baselineAt, NOW);
});

test('B+1: release searches use the same fix-version names', async () => {
  const db = memDb();
  store.ensureVersion(db, { project: 'AAP1', version: '1.9.2' });
  kv.set(db, 'bug-fixver:AAP1:1.9.2', ['1.9.1'], NOW);
  const queries = [];
  const jira = { search: async jql => { queries.push(jql); return []; } };
  const ctx = { db, dzHome: '/x', rulesFor: () => ({ version: 'v1' }), bugs: { jira: async () => jira, baseContains: async () => ({ ok: false, detail: 'x' }) } };
  const project = { key: 'AAP1', jiraStatus: { waiting: ['To Do'], inProgress: 'In Progress', resolved: 'Resolved', reopened: 'Reopened', done: ['Closed'] } };
  await assess(ctx, project, store.getVersion(db, 'AAP1', '1.9.2'), NOW);
  const scoped = queries.filter(jql => jql.includes('issuetype'));
  assert.equal(scoped.length, 3);
  for (const jql of scoped) assert.match(jql, /fixVersion in \("1\.9\.2", "1\.9\.1"\)/);
});
