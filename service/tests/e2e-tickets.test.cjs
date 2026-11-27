const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTicketClient, labelOf, TOOLS } = require('../src/e2e/tickets.cjs');
const { ALLOWED_TOOLS } = require('../src/bugs/jira-client.cjs');

const wrap = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const args = { project: 'AAP1', summary: 's', description: 'd', label: 'dz-e2e-1', priority: 'High', fixVersions: ['1.9.2'], openJql: 'labels = "dz-e2e-1"' };

function client(tools) {
  const calls = [];
  const connect = async () => ({ callTool: async ({ name, arguments: a }) => { calls.push([name, a]); return tools[name](a, calls); }, close: async () => {} });
  return { calls, api: createTicketClient({ configFile: '/none', connect, timeoutMs: 30 }) };
}

test('an open ticket of the same case is reused, not duplicated', async () => {
  const { calls, api } = client({ jira_search: () => wrap({ issues: [{ key: 'AAP1-5' }] }) });
  assert.deepEqual(await api.create(args), { key: 'AAP1-5', created: false });
  assert.equal(calls.length, 1);
});

test('a new ticket is a Bug with the label, priority and version', async () => {
  const { calls, api } = client({ jira_search: () => wrap({ issues: [] }), jira_create_issue: () => wrap({ message: 'ok', issue: { key: 'AAP1-6' } }) });
  assert.deepEqual(await api.create(args), { key: 'AAP1-6', created: true });
  const made = calls[1][1];
  assert.equal(made.issue_type, 'Bug');
  assert.deepEqual(JSON.parse(made.additional_fields), { priority: { name: 'High' }, labels: ['dz-e2e', 'dz-e2e-1'], fixVersions: [{ name: '1.9.2' }] });
});

test('a create that timed out but landed is found again instead of created twice', async () => {
  let landed = false;
  const { calls, api } = client({ jira_search: () => wrap({ issues: landed ? [{ key: 'AAP1-7' }] : [] }), jira_create_issue: () => { landed = true; return new Promise(() => {}); } });
  assert.deepEqual(await api.create(args), { key: 'AAP1-7', created: true });
  assert.equal(calls.filter(c => c[0] === 'jira_create_issue').length, 1);
});

test('only the ticket client may create issues, and labels are stable per case', () => {
  assert.equal(TOOLS, 'jira_search,jira_create_issue');
  assert.equal(ALLOWED_TOOLS.includes('jira_create_issue'), false);
  assert.equal(labelOf('A', '1', 'TC-1'), labelOf('A', '1', 'TC-1'));
  assert.notEqual(labelOf('A', '1', 'TC-1'), labelOf('A', '2', 'TC-1'));
});
