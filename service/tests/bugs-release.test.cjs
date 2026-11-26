const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { assess, checkRelease, baseContains, releaseKey, INTERVAL_MS } = require('../src/bugs/release.cjs');
const workspace = require('../src/bugs/workspace.cjs');
const merge = require('../src/bugs/merge.cjs');
const { memDb, t } = require('./bugs-fixtures.cjs');
const { readyWorld, g } = require('./bugs-git-fixtures.cjs');

const NOW = t('2026-11-26T10:00');
const project = { key: 'AAP1', jiraStatus: { waiting: ['To Do'], inProgress: 'In Progress', resolved: 'Resolved', reopened: 'Reopened', done: ['Closed'] } };

const TREE = 'a'.repeat(40);

function setup({ open = {}, merged = false, e2e = null } = {}) {
  const db = memDb();
  const version = store.ensureVersion(db, { project: 'AAP1', version: '1.9.2' });
  db.prepare('UPDATE versions SET polling = 1, baseline_at = ? WHERE project = ?').run(NOW - 86400000, 'AAP1');
  const queries = [];
  const hits = { high: [], resolved: [], low: [], ...open };
  const jira = {
    search: async jql => {
      queries.push(jql);
      const list = jql.includes('priority in (Highest, High)') ? hits.high : jql.includes('status in ("Resolved", "Reopened")') ? hits.resolved : hits.low;
      return list.map(key => ({ key }));
    },
  };
  const ctx = { db, dzHome: '/x', rulesFor: () => ({ version: 'v1' }), bugs: { jira: async () => jira, baseContains: async () => ({ ok: merged, detail: 'git' }), versionTip: async () => ({ sha: 'b'.repeat(40), tree: TREE }) } };
  if (e2e) kv.set(db, 'e2e:AAP1:1.9.2', { result: { tree: TREE, status: 'pass', failures: [], incomplete: [], ...e2e } }, NOW);
  return { db, ctx, version: store.getVersion(db, 'AAP1', '1.9.2'), queries, hits };
}

const flags = result => result.conditions.map(c => c.ok);
const decisions = (db, code) => db.prepare('SELECT * FROM decisions WHERE code = ?').all(code);
const waits = db => db.prepare("SELECT role, subject, state FROM waits WHERE state = 'open'").all();

test('R01: 2-6 satisfied and not merged is a merge ping, all six is a release', async () => {
  assert.equal((await assess(...(s => [s.ctx, project, s.version, NOW])(setup({ e2e: {} })))).ready, 'merge');
  assert.equal((await assess(...(s => [s.ctx, project, s.version, NOW])(setup({ e2e: {}, merged: true })))).ready, 'release');
});

test('condition 6: E2E on an older tree is chưa có, a failed one on the same tree is false, an accepted one is true', async () => {
  const six = async e2e => (s => assess(s.ctx, project, s.version, NOW))(setup({ e2e })).then(r => r.conditions[5]);
  assert.deepEqual(await six({ tree: 'c'.repeat(40) }), { n: 6, ok: null, detail: 'chưa có' });
  assert.equal((await six({ status: 'fail', failures: [{ id: 'TC-1' }] })).ok, false);
  assert.match((await six({ status: 'fail', failures: [{ id: 'TC-1' }] })).detail, /TC-1/);
  assert.equal((await six({ status: 'accepted', accepted: { by: 'Lan', at: 1 } })).ok, true);
});

test('every condition satisfied except the unfinished E2E: condition 6 is chưa có and nobody is pinged', async () => {
  const s = setup();
  const result = await assess(s.ctx, project, s.version, NOW);
  assert.deepEqual(flags(result), [false, true, true, true, true, null]);
  assert.equal(result.conditions[5].detail, 'chưa có');
  assert.equal(result.ready, 'none');
});

test('condition 2: an open Highest/High bug of the version blocks, and names it', async () => {
  const s = setup({ open: { high: ['AAP1-9'] } });
  const result = await assess(s.ctx, project, s.version, NOW);
  assert.equal(result.conditions[1].ok, false);
  assert.match(result.conditions[1].detail, /AAP1-9/);
  assert.equal(result.ready, 'none');
});

test('condition 3: a Resolved or Reopened bug blocks until QA closes it', async () => {
  const s = setup({ open: { resolved: ['AAP1-3'] } });
  const result = await assess(s.ctx, project, s.version, NOW);
  assert.deepEqual(flags(result).slice(1, 3), [true, false]);
  assert.equal(result.ready, 'none');
});

test('condition 4: remaining Medium/Low bugs block', async () => {
  const s = setup({ open: { low: ['AAP1-4', 'AAP1-5'] } });
  const result = await assess(s.ctx, project, s.version, NOW);
  assert.equal(result.conditions[3].ok, false);
  assert.equal(result.ready, 'none');
});

test('condition 5: an open PO wait blocks, a resolved one does not', async () => {
  const s = setup();
  s.db.prepare("INSERT INTO waits (project, role, subject, opened_at) VALUES ('AAP1', 'po', 'hỏi', 1)").run();
  assert.equal((await assess(s.ctx, project, s.version, NOW)).conditions[4].ok, false);
  s.db.prepare("UPDATE waits SET state = 'resolved'").run();
  assert.equal((await assess(s.ctx, project, s.version, NOW)).conditions[4].ok, true);
});

test('condition 1 true with 6 unknown is not a merge ping and not a release', async () => {
  const s = setup({ merged: true });
  const result = await assess(s.ctx, project, s.version, NOW);
  assert.equal(result.conditions[0].ok, true);
  assert.equal(result.ready, 'none');
});

test('the Jira searches are limited to the version bugs: fixVersion, or created since the baseline without one', async () => {
  const s = setup();
  await assess(s.ctx, project, s.version, NOW);
  const scoped = s.queries.filter(jql => jql.includes('issuetype'));
  assert.equal(scoped.length, 3);
  for (const jql of scoped) {
    assert.match(jql, /project = AAP1 AND issuetype = Bug AND \(fixVersion in \("1\.9\.2"\) OR \(fixVersion is EMPTY AND created >= "2026-11-25 10:00"\)\)/);
  }
});

test('R01: reaching merge-ready records once and opens one dev wait; a repeat inside 15 minutes is skipped', async () => {
  const s = setup({ e2e: {} });
  assert.equal((await checkRelease(s.ctx, project, s.version, NOW)).ready, 'merge');
  assert.equal(await checkRelease(s.ctx, project, s.version, NOW + INTERVAL_MS - 1), null);
  await checkRelease(s.ctx, project, s.version, NOW + INTERVAL_MS);
  await checkRelease(s.ctx, project, s.version, NOW + 2 * INTERVAL_MS, { force: true });
  assert.equal(decisions(s.db, 'R01').length, 1);
  assert.equal(decisions(s.db, 'R01')[0].action, 'ping-merge');
  assert.deepEqual(waits(s.db).map(w => w.role), ['dev']);
});

test('a merge wait is closed when the version stops being ready', async () => {
  const s = setup({ e2e: {} });
  await checkRelease(s.ctx, project, s.version, NOW);
  s.hits.high = ['AAP1-9'];
  await checkRelease(s.ctx, project, s.version, NOW + 1, { force: true });
  assert.deepEqual(waits(s.db), []);
  assert.equal(decisions(s.db, 'R02').length, 0);
});

test('R02: a new Highest/High bug after the release notice withdraws it and returns polling to 3 minutes', async () => {
  const s = setup({ open: { high: ['AAP1-9'] } });
  const waitId = s.db.prepare("INSERT INTO waits (project, role, subject, opened_at) VALUES ('AAP1', 'dev', 'Bản 1.9.2 đủ điều kiện release (R01)', 1)").run().lastInsertRowid;
  kv.set(s.db, releaseKey('AAP1', '1.9.2'), { at: 0, ready: 'release', waits: { release: Number(waitId) } }, 1);
  s.db.prepare('UPDATE versions SET last_new_at = 5 WHERE project = ?').run('AAP1');
  await checkRelease(s.ctx, project, s.version, NOW, { force: true });
  assert.equal(decisions(s.db, 'R02').length, 1);
  assert.equal(decisions(s.db, 'R02')[0].action, 'revoke-release');
  assert.deepEqual(waits(s.db), []);
  assert.equal(store.getVersion(s.db, 'AAP1', '1.9.2').lastNewAt, NOW);
  await checkRelease(s.ctx, project, s.version, NOW + 1, { force: true });
  assert.equal(decisions(s.db, 'R02').length, 1);
});

test('condition 1 reads git: version tip equal to base is merged, ahead of base is not, pushed to base is again', async tt => {
  const w = await readyWorld(tt);
  const ctx = { dzHome: w.dzHome, bugs: { git: { workspace }, githubUrl: w.github } };
  const version = { version: '1.9.2' };
  assert.equal((await baseContains(ctx, w.project, version)).ok, true);
  const lane = w.lane('fix/one', { 'one.txt': '1\n' });
  const out = await merge.mergeBatch({ ...w.merge, branches: [{ branch: 'fix/one', commit: lane }] });
  const behind = await baseContains(ctx, w.project, version);
  assert.equal(behind.ok, false);
  g(w.mirror, 'push', '-q', w.github, `${out.sha}:refs/heads/develop`);
  assert.equal((await baseContains(ctx, w.project, version)).ok, true);
});
