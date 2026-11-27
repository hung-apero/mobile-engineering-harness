const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBugs } = require('../src/bugs/wire.cjs');
const { createFakeJira } = require('./fixtures/fake-jira.cjs');
const { makeHome } = require('./service-fixtures.cjs');

function setup(t) {
  const h = makeHome(t);
  const ctx = h.context();
  const fake = createFakeJira({ issues: { 'ABC1-1': { status: 'To Do', transitions: [{ id: '5', name: 'Resolve', to_status: 'Resolved' }] } } });
  return { ctx, fake, bugs: createBugs(ctx, { connect: fake.connect }), dry: { key: 'ABC1', live: false }, live: { key: 'ABC1', live: true } };
}

test('jira adapters are cached per project and mode', async t => {
  const s = setup(t);
  const a = await s.bugs.jira(s.dry);
  assert.equal(await s.bugs.jira(s.dry), a);
  assert.notEqual(await s.bugs.jira(s.live), a);
  assert.notEqual(await s.bugs.jira({ key: 'DEF2', live: false }), a);
});

test('closeAll closes every connected adapter and forgets them', async t => {
  const s = setup(t);
  await (await s.bugs.jira(s.dry)).search('project = ABC1');
  await (await s.bugs.jira(s.live)).search('project = ABC1');
  await s.bugs.closeAll();
  assert.equal(s.fake.closes, 2);
  assert.notEqual(await s.bugs.jira(s.dry), undefined);
  await s.bugs.closeAll();
  assert.equal(s.fake.closes, 2);
});

test('a dry-run adapter writes a would decision instead of touching Jira', async t => {
  const s = setup(t);
  const jira = await s.bugs.jira(s.dry);
  assert.deepEqual(await jira.transition('ABC1-1', 'Resolved'), { dryRun: true });
  assert.equal(s.fake.calls.some(call => call.name === 'jira_transition_issue'), false);
  const row = s.ctx.db.prepare("SELECT action, evidence FROM decisions WHERE action = 'would'").get();
  assert.match(JSON.parse(row.evidence).text, /transition ABC1-1 -> Resolved/);
});

test('the git members are the modules and advanceBatch is injectable', t => {
  const s = setup(t);
  for (const name of ['workspace', 'merge', 'landing', 'diffGuard']) assert.equal(typeof s.bugs.git[name], 'object');
  assert.equal(typeof s.bugs.advanceBatch, 'function');
  assert.equal(typeof s.ctx.bugs.jira, 'function');
});
