const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProjects } = require('../src/projects.cjs');
const { tick } = require('../src/tick.cjs');
const { openWait } = require('../src/pings.cjs');
const { liveChannels } = require('../channels/access.cjs');
const { setup: projectsSetup, yamlFor } = require('./projects-fixtures.cjs');
const { makeHome, MIN } = require('./service-fixtures.cjs');
const mcp = require('./mcp-fixtures.cjs');
const flow = require('./specs-flow-fixtures.cjs');

const SPEC_URL = 'https://example.atlassian.net/wiki/spaces/EX/pages/332470208/Phase';
const WEDNESDAY_10H = Date.parse('2026-11-25T10:00:00+07:00');

function load(t, overrides) {
  const { root, dzHome, dir } = projectsSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ABC1.yaml'), yamlFor('ABC1', dzHome, overrides));
  return loadProjects(dir, { dzHome });
}

test('discord field parses and defaults false', t => {
  assert.equal(load(t).projects.get('ABC1').discord, false);
  assert.equal(load(t, { discord: true }).projects.get('ABC1').discord, true);
});

test('non boolean discord is rejected', t => {
  const { projects, errors } = load(t, { discord: 'yes' });
  assert.equal(projects.has('ABC1'), false);
  assert.match(JSON.stringify(errors), /discord/);
});

test('bot replies for real when discord true and live false', async t => {
  const s = mcp.setup(t, { specs: [mcp.review(1)], projects: [mcp.project('AAP864', { discord: true })] });
  await s.call('submit', s.discord.post(SPEC_URL));
  assert.deepEqual(s.discord.posts().map(c => c.path.split('/').pop()), ['threads', 'messages']);
  assert.equal(s.would.length, 0);
});

test('pings use webhook when discord true', async t => {
  const h = makeHome(t);
  h.project('ABC1', { discord: true });
  h.webhook('ABC1');
  const ctx = h.context();
  const sent = [];
  ctx.send = async message => { sent.push(message); return { ok: true }; };
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, WEDNESDAY_10H - 3 * 24 * 60 * MIN);
  await tick(ctx, WEDNESDAY_10H);
  assert.equal(sent.length, 1);
  assert.match(sent[0].webhookFile, /ABC1\.discord-webhook$/);
});

test('desk reply channels include discord projects', () => {
  assert.deepEqual(liveChannels([mcp.project('AAA', { discord: true })]), [mcp.CHANNEL]);
  assert.deepEqual(liveChannels([mcp.project('AAA', { discord: true }), mcp.project('BBB')]), []);
});

test('jira and git effects stay would when only discord is true', async t => {
  const s = flow.setup(t, { source: { type: 'url', ref: '332470208' } });
  const comments = [];
  s.ctx.specs.confluence = () => ({
    page: async () => ({ id: '9', title: '[ABC1] Phase 15', markdown: '# a', version: 1, url: '' }),
    commentOnce: async (...args) => { comments.push(args); return { skipped: false }; },
  });
  s.h.project('ABC1', { discord: true });
  await s.toReview();
  assert.equal((await s.facade.approve(s.id, { sha: s.facade.review(s.id).sha, quote: 'Duyệt' }, 'po', s.now)).ok, true);
  await s.tick();
  await s.tick();
  assert.deepEqual(comments, []);
  assert.match(s.decisions('would').at(-1).evidence, /confluence comment/);
  for (const { args } of s.calls) assert.ok(args.includes('Bash(git push:*)'));
});
