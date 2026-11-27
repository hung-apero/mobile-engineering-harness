const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJira, JiraError } = require('../src/bugs/jira.cjs');
const { createFakeJira } = require('./fixtures/fake-jira.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dz-jira-'));
const TRANSITIONS = [
  { id: '11', name: 'Start', to_status: 'In Progress' },
  { id: '21', name: 'Done it', to_status: 'Fixed' },
];
function setup({ live = true, issues, wrapResult = false } = {}) {
  const fake = createFakeJira({ wrapResult, issues: issues ?? { 'A-1': { status: 'Open', transitions: TRANSITIONS, labels: ['x'], assignee: { displayName: 'Dev' } } } });
  const records = [];
  const jira = createJira({ configFile: '/none', live, record: (...a) => records.push(a), connect: fake.connect, timeoutMs: fake.timeoutMs });
  return { fake, jira, records };
}
const names = fake => fake.calls.map(c => c.name);

test('search pages through results up to 200 and unwraps the {"result": json-string} envelope', async () => {
  const issues = {};
  for (let n = 0; n < 130; n += 1) issues[`A-${n}`] = { status: 'Open' };
  for (const wrapResult of [false, true]) {
    const { jira, fake } = setup({ issues, wrapResult });
    const found = await jira.search('project = A', { limit: 200 });
    assert.equal(found.length, 130);
    assert.equal(fake.calls.filter(c => c.name === 'jira_search').length, 3);
    assert.ok(fake.calls.every(c => c.args.limit <= 50));
    assert.deepEqual(found[0].status, { name: 'Open' });
  }
  const many = {};
  for (let n = 0; n < 260; n += 1) many[`B-${n}`] = { status: 'Open' };
  assert.equal((await setup({ issues: many }).jira.search('x', {})).length, 200);
});

test('transition picks the transition by target status name, re-reads to confirm, leaves the assignee alone', async () => {
  const { jira, fake } = setup();
  const result = await jira.transition('A-1', 'fixed');
  assert.equal(result.status, 'Fixed');
  assert.equal(fake.issues['A-1'].status, 'Fixed');
  assert.equal(fake.calls.find(c => c.name === 'jira_transition_issue').args.transition_id, '21');
  assert.equal(names(fake).at(-1), 'jira_get_issue');
  await assert.rejects(() => jira.transition('A-1', 'Nowhere'), JiraError);
});

test('transition throws when the assignee changed across the write', async () => {
  const { jira, fake } = setup();
  fake.drift = 'assignee';
  await assert.rejects(() => jira.transition('A-1', 'Fixed'), /assignee/);
});

test('comment appends the marker on the last line and skips when a comment already carries it', async () => {
  const { jira, fake } = setup();
  const marker = 'dz:b1:A-1:fix';
  const first = await jira.comment('A-1', marker, 'đã sửa xong');
  assert.equal(first.dryRun, undefined);
  const body = fake.issues['A-1'].comments[0];
  assert.ok(body.startsWith('[Claude]'));
  assert.equal(body.trimEnd().split('\n').at(-1), marker);
  const again = await jira.comment('A-1', marker, 'đã sửa xong');
  assert.equal(again.skipped, true);
  assert.equal(fake.issues['A-1'].comments.length, 1);
});

test('comment after a timeout re-reads before deciding and never writes twice', async () => {
  const { jira, fake } = setup();
  fake.fail = { name: 'jira_add_comment', mode: 'apply-then-hang', times: 1 };
  const r = await jira.comment('A-1', 'dz:b:A-1:s', 'x');
  assert.equal(r.confirmed, true);
  assert.equal(fake.calls.filter(c => c.name === 'jira_add_comment').length, 1);
  assert.equal(fake.issues['A-1'].comments.length, 1);
});

test('labels are read, merged, written and read back; removal likewise', async () => {
  const { jira, fake } = setup();
  const added = await jira.addLabels('A-1', ['y', 'x']);
  assert.deepEqual(added.labels.sort(), ['x', 'y']);
  assert.deepEqual(JSON.parse(fake.calls.find(c => c.name === 'jira_update_issue').args.fields), { labels: ['x', 'y'] });
  const removed = await jira.removeLabels('A-1', ['x']);
  assert.deepEqual(removed.labels, ['y']);
  fake.drift = 'assignee';
  await assert.rejects(() => jira.addLabels('A-1', ['z']), /assignee/);
});

test('dry run records would: lines for every write and returns {dryRun:true} without calling write tools', async () => {
  const { jira, fake, records } = setup({ live: false });
  assert.deepEqual(await jira.transition('A-1', 'Fixed'), { dryRun: true });
  assert.deepEqual(await jira.comment('A-1', 'm', 't'), { dryRun: true });
  assert.deepEqual(await jira.addLabels('A-1', ['q']), { dryRun: true });
  assert.deepEqual(await jira.removeLabels('A-1', ['q']), { dryRun: true });
  assert.equal(records.length, 4);
  assert.ok(records.every(r => r[0] === 'would'));
  assert.ok(!names(fake).some(n => ['jira_transition_issue', 'jira_add_comment', 'jira_update_issue'].includes(n)));
  assert.equal((await jira.issue('A-1')).key, 'A-1');
});

test('a dead transport reconnects once and retries a read; a second failure throws JiraError', async () => {
  const { jira, fake } = setup();
  fake.fail = { name: 'jira_get_issue', mode: 'dead', times: 1 };
  assert.equal((await jira.issue('A-1')).key, 'A-1');
  assert.equal(fake.connects, 2);
  fake.fail = { name: 'jira_get_issue', mode: 'dead', times: 2 };
  await assert.rejects(() => jira.issue('A-1'), JiraError);
});

test('a call that never answers times out into JiraError', async () => {
  const { jira, fake } = setup();
  fake.fail = { name: 'jira_get_transitions', mode: 'hang', times: 2 };
  await assert.rejects(() => jira.transitions('A-1'), JiraError);
});

test('issue truncates comments to 8000 characters', async () => {
  const { jira } = setup({ issues: { 'A-1': { status: 'Open', comments: ['y'.repeat(20000)] } } });
  const issue = await jira.issue('A-1');
  assert.ok(issue.comment.comments[0].body.length <= 8000);
});

test('errors carry no token or url secrets', async () => {
  const fake = createFakeJira({ issues: {} });
  const jira = createJira({ configFile: '/none', live: true, record() {}, timeoutMs: 50, connect: async () => ({ callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'denied Bearer abc123token at https://x.atlassian.net/?token=ATATTsecret' }] }), close: async () => {} }) });
  await assert.rejects(() => jira.issue('A-1'), e => e instanceof JiraError && !/abc123token|ATATTsecret/.test(e.message));
  assert.ok(fake);
});
