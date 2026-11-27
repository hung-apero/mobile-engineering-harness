const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const { mergeBatch } = require('../src/bugs/merge.cjs');
const { watchBase } = require('../src/bugs/base-watch.cjs');
const { ensureMirror, ensureVersionBranch, ensureClone } = require('../src/bugs/workspace.cjs');
const { baseContains } = require('../src/bugs/release.cjs');
const { g, commit } = require('./bugs-git-fixtures.cjs');
const { setup, VERSION } = require('./e2e-fixtures.cjs');

const DAY = 86400000;
const NOW = Date.now();

async function world(t, { live = true, files = { 'one.txt': '1\n' }, pr = true } = {}) {
  const s = await setup(t, { live, build: false });
  if (pr) s.db.prepare("INSERT INTO batches (project, version, kind, state, keys, data, opened_at, updated_at) VALUES ('AAP1', ?, 'normal', 'done', '[]', ?, 1, 1)").run(VERSION, JSON.stringify({ pr: { number: 7, url: 'https://github.com/Apero/AAP1/pull/7' } }));
  s.merged = [];
  s.ctx.bugs.gh = async args => {
    s.gh.push(args);
    return { stdout: JSON.stringify(s.merged) };
  };
  s.add = async (name, content) => {
    const sha = s.lane(`fix/${name}`, content);
    return (await mergeBatch({ ...s.merge, branches: [{ branch: `fix/${name}`, commit: sha }] })).sha;
  };
  s.tip = await s.add('one', files);
  s.watch = async (now = NOW) => {
    await ensureMirror({ dzHome: s.dzHome, project: s.project, githubUrl: s.github });
    kv.del(s.db, `base-watch:AAP1:${VERSION}`);
    return watchBase(s.ctx, s.project, s.version(), now);
  };
  s.develop = content => {
    g(s.dev, 'pull', '-q', 'origin', 'develop');
    const sha = commit(s.dev, content, 'squash (#7)');
    g(s.dev, 'push', '-q', 'origin', 'HEAD:refs/heads/develop');
    return sha;
  };
  return s;
}

test('F07: a small fresh PR is not pinged; its oldest commit older than one working day is, once, due at once', async t => {
  const s = await world(t);
  await s.watch(NOW);
  assert.deepEqual(s.waits('dev'), []);
  await s.watch(NOW + 5 * DAY);
  await s.watch(NOW + 6 * DAY);
  assert.deepEqual(s.waits('dev'), [`Merge PR ${s.branch} (commit cũ nhất quá 1 ngày làm việc)`]);
  assert.deepEqual(s.actions('F07'), ['ping-merge']);
  assert.ok(s.db.prepare('SELECT opened_at FROM waits').get().opened_at <= NOW + 5000);
});

test('F07: an open PR above 400 lines is pinged, and the ping closes when it shrinks under the limit', async t => {
  const s = await world(t, { files: { 'big.txt': 'x\n'.repeat(401) } });
  await s.watch(NOW);
  assert.deepEqual(s.waits('dev'), [`Merge PR ${s.branch} (quá 400 dòng)`]);
  s.ctx.rulesFor = () => ({ version: 'v1', rules: { F07: { max_pr_lines: 900 } } });
  await s.watch(NOW);
  assert.deepEqual(s.waits('dev'), []);
});

test('F07: without a PR, or once base contains the tip, nobody is pinged', async t => {
  const none = await world(t, { pr: false });
  await none.watch(NOW + 5 * DAY);
  assert.deepEqual(none.waits('dev'), []);
  const s = await world(t);
  g(s.mirror, 'push', '-q', s.github, `${s.tip}:refs/heads/develop`);
  assert.equal(await s.watch(NOW + 5 * DAY), false);
  assert.deepEqual(s.waits('dev'), []);
  assert.equal(s.version().branch, s.branch);
});

test('F08: a squash whose content base already holds opens the next branch from base, without touching the old one', async t => {
  const s = await world(t);
  await s.watch(NOW + 5 * DAY);
  const base = s.develop({ 'one.txt': '1\n', 'other.txt': 'của dev\n' });
  assert.equal(await s.watch(NOW + 5 * DAY), true);
  assert.equal(s.version().branch, `${s.branch}-2`);
  assert.equal(s.ref(`${s.branch}-2`), base);
  assert.equal(s.ref(s.branch), s.tip);
  assert.deepEqual(s.actions('F08'), ['next-branch']);
  assert.deepEqual(s.waits('dev'), []);
  assert.equal(g(s.root, 'ls-remote', s.github, 'refs/heads/dz/*'), `${base}\trefs/heads/${s.branch}-2`);
  assert.equal((await baseContains({ dzHome: s.dzHome, bugs: { git: s.ctx.bugs.git, githubUrl: s.github } }, s.project, s.version())).ok, true);
});

test('F08: the next batch is cloned from the new branch', async t => {
  const s = await world(t);
  const base = s.develop({ 'one.txt': '1\n' });
  await s.watch();
  const { branch } = s.version();
  assert.equal((await ensureVersionBranch({ ...s.ctx, project: s.project, githubUrl: s.github, version: VERSION, branch })).sha, base);
  const clone = await ensureClone({ dzHome: s.dzHome, project: s.project, batch: { id: 9, version: VERSION, branch } });
  assert.equal(clone.startSha, base);
});

test('F08: gh reporting a squash merged PR carries the commits made after it', async t => {
  const s = await world(t);
  const head = s.tip;
  const squash = s.develop({ 'one.txt': '1\n' });
  await s.add('two', { 'two.txt': '2\n' });
  s.merged = [{ number: 7, headRefOid: head, mergeCommit: { oid: squash } }];
  assert.equal(await s.watch(), true);
  const next = s.version().branch;
  assert.equal(g(s.mirror, 'show', `${next}:two.txt`), '2');
  assert.equal(g(s.mirror, 'rev-parse', `${next}^`), squash);
});

test('F08: carried commits that conflict leave the branch and wake the dev', async t => {
  const s = await world(t);
  const head = s.tip;
  const squash = s.develop({ 'one.txt': '1\n', 'a.txt': 'dev\n' });
  await s.add('two', { 'a.txt': 'bot\n' });
  s.merged = [{ number: 7, headRefOid: head, mergeCommit: { oid: squash } }];
  assert.equal(await s.watch(), false);
  assert.equal(s.version().branch, s.branch);
  assert.match(s.waits('dev').join(), /F08/);
});

test('F08: a merge commit, a closed PR, or work cancelled out on the branch is not a squash', async t => {
  const s = await world(t);
  await s.watch();
  assert.equal(s.version().branch, s.branch);
  const merged = await world(t);
  g(merged.mirror, 'push', '-q', merged.github, `${merged.tip}:refs/heads/develop`);
  await merged.add('two', { 'two.txt': '2\n' });
  merged.merged = [{ number: 7, headRefOid: merged.tip, mergeCommit: { oid: merged.tip } }];
  await merged.watch();
  assert.equal(merged.version().branch, merged.branch);
  const undone = await world(t, { files: { 'one.txt': '1\n' } });
  const empty = g(undone.mirror, 'commit-tree', `${undone.startSha}^{tree}`, '-p', undone.tip, '-m', 'undo');
  g(undone.mirror, 'update-ref', `refs/heads/${undone.branch}`, empty);
  await undone.watch();
  assert.equal(undone.version().branch, undone.branch);
});

test('F08: a running batch postpones the switch; a dry project only records would, once', async t => {
  const s = await world(t);
  s.develop({ 'one.txt': '1\n' });
  s.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('AAP1', ?, 'normal', 'running', '[]', 1, 1)").run(VERSION);
  assert.equal(await s.watch(), false);
  s.db.prepare("UPDATE batches SET state = 'done'").run();
  assert.equal(await s.watch(), true);
  const dry = await world(t, { live: false });
  dry.develop({ 'one.txt': '1\n' });
  await dry.watch();
  await dry.watch();
  assert.equal(dry.version().branch, dry.branch);
  assert.deepEqual(dry.actions('DRY'), ['would']);
  assert.equal(dry.gh.length, 0);
});
