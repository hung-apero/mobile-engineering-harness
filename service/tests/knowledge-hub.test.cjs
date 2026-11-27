const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { kbAccess, KB_TOOLS, KB_DENIED } = require('../src/knowledge-hub.cjs');
const { workerArgs } = require('../src/worker.cjs');
const spec = require('../src/handlers/spec.cjs');
const bug = require('../src/handlers/bug.cjs');
const uidiff = require('../src/handlers/uidiff.cjs');
const { setup, SHA, LANE_SHA } = require('./handlers-fixtures.cjs');

const READS = ['mcp__knowledge-hub__search_knowledge', 'mcp__knowledge-hub__read_knowledge', 'mcp__knowledge-hub__list_knowledge'];
const WRITES = ['mcp__knowledge-hub__propose_change', 'mcp__knowledge-hub__get_change_status', 'mcp__knowledge-hub__hook_context'];

function world(t) {
  const w = setup(t);
  const bin = path.join(w.dzHome, 'kb-bin');
  fs.mkdirSync(bin);
  const command = path.join(bin, 'knowledge-hub-mcp');
  fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const repo = path.join(w.dzHome, 'workspaces', 'AAP864', 'specs', '7', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(w.dzHome, 'secrets', 'figma-read.json'), JSON.stringify({ mcpServers: { 'framelink-figma': { command: 'npx', args: [] } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(w.dzHome, 'secrets', 'jira-read.json'), JSON.stringify({ mcpServers: { jira: { command: 'uvx', args: [], env: { READ_ONLY_MODE: 'true', ENABLED_TOOLS: 'jira_get_issue,jira_search,jira_get_transitions,jira_download_attachments' } } } }), { mode: 0o600 });
  const options = { dzHome: w.dzHome, project: w.project, adb: '/usr/bin/true', searchPath: `/nowhere${path.delimiter}${bin}` };
  return { ...w, bin, command, repo, options };
}

const assertKb = (out, command) => {
  assert.deepEqual(out.extraMcp.map(text => JSON.parse(text)), [{ mcpServers: { 'knowledge-hub': { command, args: [] } } }]);
  for (const name of READS) assert.ok(out.allowedTools.includes(name), name);
  for (const name of WRITES) assert.ok(out.disallowedTools.includes(name), name);
};

test('the hub is offered read-only when knowledge-hub-mcp is on the path, and not at all otherwise', t => {
  const w = world(t);
  assert.deepEqual([KB_TOOLS, KB_DENIED], [READS, WRITES]);
  const found = kbAccess(w.options.searchPath);
  assert.deepEqual(JSON.parse(found.mcp[0]), { mcpServers: { 'knowledge-hub': { command: w.command, args: [] } } });
  assert.deepEqual([found.allowed, found.denied], [READS, WRITES]);
  assert.deepEqual(kbAccess('/nowhere'), { mcp: [], allowed: [], denied: WRITES });
  assert.deepEqual(kbAccess(undefined), { mcp: [], allowed: [], denied: WRITES });
});

test('the worker passes the secret config file and the inline hub config to one --mcp-config', () => {
  const inline = '{"mcpServers":{}}';
  const both = workerArgs({ prompt: 'p', mcpConfig: '/x/mcp.json', extraMcp: [inline] });
  const at = both.indexOf('--mcp-config');
  assert.deepEqual(both.slice(at + 1, at + 3), ['/x/mcp.json', inline]);
  assert.equal(both.filter(arg => arg === '--mcp-config').length, 1);
  const only = workerArgs({ prompt: 'p', extraMcp: [inline] });
  assert.equal(only[only.indexOf('--mcp-config') + 1], inline);
  assert.ok(!workerArgs({ prompt: 'p', extraMcp: [] }).includes('--mcp-config'));
  assert.equal(both.at(-1), 'p');
});

test('spec ask and build workers, bug workers and ui diff workers get the hub', t => {
  const w = world(t);
  const job = payload => ({ slotsGranted: 2, payload: { specId: 7, repo: w.repo, ...payload } });
  assertKb(spec.prepare(job({ segment: 'build', branch: 'dz/spec-7' }), w.options), w.command);
  const figma = spec.prepare(job({ segment: 'build', branch: 'dz/spec-7', figma: true }), w.options);
  assertKb(figma, w.command);
  assert.equal(figma.mcpConfig, path.join(w.dzHome, 'secrets', 'figma-read.json'));
  const bugOut = bug.prepare({ slotsGranted: 2, payload: { batchId: '7', version: '1.9.2', keys: ['AAP864-275'], round: 1, repo: w.repo, startSha: SHA } }, w.options);
  assertKb(bugOut, w.command);
  assert.equal(bugOut.mcpConfig, path.join(w.dzHome, 'secrets', 'jira-read.json'));
  const ui = uidiff.prepare({ payload: { repo: w.repo, serial: 'AAA', round: 1, figmaUrl: 'https://www.figma.com/design/AbC123/App', screens: [{ slug: 'home', name: 'Home' }] } }, w.options);
  assertKb(ui, w.command);
});

test('without the binary on the path no worker gets a hub config', t => {
  const w = world(t);
  const options = { ...w.options, searchPath: '/nowhere' };
  const out = spec.prepare({ slotsGranted: 2, payload: { specId: 7, repo: w.repo, segment: 'build', branch: 'dz/spec-7' } }, options);
  assert.deepEqual(out.extraMcp, []);
  assert.ok(!out.allowedTools.some(name => name.startsWith('mcp__knowledge-hub__')));
});

test('the spec review worker stays on git reads only', t => {
  const w = world(t);
  const repo = path.join(w.dzHome, 'workspaces', 'AAP864', 'batches', 'spec-7', 'review');
  fs.mkdirSync(repo, { recursive: true });
  const specFile = path.join(path.dirname(repo), 'spec.md');
  fs.writeFileSync(specFile, '# Spec\n');
  const out = spec.prepare({ payload: { specId: 7, type: 'review', repo, specFile, startSha: SHA, sha: LANE_SHA, title: 'x' } }, w.options);
  assert.equal(out.extraMcp, undefined);
  assert.ok(!out.allowedTools.some(name => name.startsWith('mcp__')));
});
