const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const { mergeBatch } = require('../src/bugs/merge.cjs');
const { ensureMirror } = require('../src/bugs/workspace.cjs');
const { watchBase, lastPr } = require('../src/bugs/base-watch.cjs');
const { startE2e } = require('../src/e2e/step.cjs');
const { g } = require('./bugs-git-fixtures.cjs');
const { merged, buildJob } = require('./release-merged-fixtures.cjs');
const { NOW, VERSION, OK } = require('./e2e-fixtures.cjs');

const HOUR = 3600000;
const start = s => startE2e(s.ctx, s.project, s.version(), OK, NOW);

async function squashed(t, { carry = false } = {}) {
  const s = await merged(t);
  s.db.prepare("INSERT INTO batches (project, version, kind, state, keys, data, opened_at, updated_at) VALUES ('AAP1', ?, 'normal', 'done', '[]', ?, 1, 1)").run(VERSION, JSON.stringify({ pr: { number: 7, url: 'https://github.com/Apero/AAP1/pull/7' } }));
  const head = s.tip;
  const squash = s.baseWork({ 'one.txt': '1\n', 'other.txt': 'dev\n' });
  if (carry) {
    const sha = s.lane('fix/two', { 'two.txt': '2\n' });
    await mergeBatch({ ...s.merge, branches: [{ branch: 'fix/two', commit: sha }] });
  }
  s.ctx.bugs.gh = async args => {
    s.gh.push(args);
    if (args[1] === 'create') return { stdout: 'https://github.com/Apero/AAP1/pull/8\n' };
    return { stdout: JSON.stringify(args.includes('merged') && carry ? [{ number: 7, headRefOid: head, mergeCommit: { oid: squash } }] : []) };
  };
  s.watch = async (now = NOW) => {
    await ensureMirror({ dzHome: s.dzHome, project: s.project, githubUrl: s.github });
    kv.del(s.db, `base-watch:AAP1:${VERSION}`);
    return watchBase(s.ctx, s.project, s.version(), now);
  };
  return s;
}

test('F10: a rollover with carried commits pushes the branch, opens its PR and F06/F07 read that PR, not the merged one', async t => {
  const s = await squashed(t, { carry: true });
  assert.equal(lastPr(s.db, 'AAP1', s.version()).number, 7);
  assert.equal(await s.watch(), true);
  const next = `${s.branch}-2`;
  assert.equal(s.version().branch, next);
  assert.equal(g(s.root, 'ls-remote', s.github, `refs/heads/${next}`).split('\t')[0], s.ref(next));
  assert.ok(s.gh.some(args => args[1] === 'create' && args.includes(next)));
  assert.equal(lastPr(s.db, 'AAP1', s.version()).number, 8);
});

test('F10: a rollover without carried commits pushes the branch, opens no PR, and its tree is built for E2E', async t => {
  const s = await squashed(t);
  assert.equal(await s.watch(), true);
  assert.ok(g(s.root, 'ls-remote', s.github, `refs/heads/${s.branch}-2`));
  assert.ok(!s.gh.some(args => args[1] === 'create'));
  assert.equal(lastPr(s.db, 'AAP1', s.version()), null);
  assert.equal(await start(s), false);
  assert.equal(buildJob(s).payload.sha, s.ref(`${s.branch}-2`));
});

test('F10: a push that fails after the rollover is retried on the same branch', async t => {
  const s = await squashed(t, { carry: true });
  const real = s.github;
  s.ctx.bugs.git = { ...s.ctx.bugs.git, merge: { ...s.ctx.bugs.git.merge, pushVersion: async () => { throw new Error('mạng'); } } };
  await assert.rejects(s.watch(), /mạng/);
  assert.equal(s.version().branch, `${s.branch}-2`);
  s.ctx.bugs.git.merge = require('../src/bugs/merge.cjs');
  await s.watch(NOW + HOUR);
  assert.ok(g(s.root, 'ls-remote', real, `refs/heads/${s.branch}-2`));
  assert.equal(lastPr(s.db, 'AAP1', s.version()).number, 8);
});
