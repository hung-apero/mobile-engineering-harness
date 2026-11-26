const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runGit } = require('../src/bugs/git.cjs');
const { mergeBatch, pushVersion, ensurePr } = require('../src/bugs/merge.cjs');
const { g, commit, readyWorld } = require('./bugs-git-fixtures.cjs');

const onGithub = (w, name) => g(w.root, 'ls-remote', w.github, `refs/heads/${name}`).split('\t')[0];
const never = () => assert.fail('không được gọi');

async function merged(t) {
  const w = await readyWorld(t);
  w.lane('fix/one', { 'one.txt': '1\n' });
  const { sha } = await mergeBatch({ ...w.merge, branches: ['fix/one'] });
  return { ...w, sha, live: { ...w.merge, live: true } };
}

test('a dry run push only records what it would do', async t => {
  const w = await merged(t);
  const git = (args, options) => (options?.remote ? never() : runGit(args, options));
  assert.deepEqual(await pushVersion({ ...w.merge, git }), { pushed: true, dryRun: true, branch: w.branch, sha: w.sha });
  assert.deepEqual(w.records, [['would', `git push ${w.sha}:refs/heads/${w.branch} (Apero/AAP1)`]]);
  assert.equal(onGithub(w, w.branch), '');
});

test('a live push moves only the version branch, verifies it, and is a no-op the second time', async t => {
  const w = await merged(t);
  const base = onGithub(w, 'develop');
  assert.deepEqual(await pushVersion(w.live), { pushed: true, branch: w.branch, sha: w.sha });
  assert.equal(onGithub(w, w.branch), w.sha);
  assert.equal(onGithub(w, 'develop'), base);
  assert.equal(g(w.root, 'ls-remote', w.github, 'refs/heads/*', 'refs/tags/*').split('\n').length, 2);
  assert.equal((await pushVersion(w.live)).pushed, false);
});

test('a live push can be pinned to an older commit of the version branch only', async t => {
  const w = await merged(t);
  assert.equal((await pushVersion({ ...w.live, sha: w.startSha })).sha, w.startSha);
  assert.equal(onGithub(w, w.branch), w.startSha);
  const foreign = w.lane('fix/two', { 'two.txt': '2\n' });
  await assert.rejects(pushVersion({ ...w.live, sha: foreign }), { code: 'INVALID' });
});

test('a branch that moved on GitHub is an error and is never forced', async t => {
  const w = await merged(t);
  const theirs = commit(w.dev, { 'x.txt': 'dev\n' });
  g(w.dev, 'push', '-q', 'origin', `HEAD:refs/heads/${w.branch}`);
  await assert.rejects(pushVersion(w.live), { code: 'DIVERGED' });
  assert.equal(onGithub(w, w.branch), theirs);
});

test('a push that GitHub did not keep is an error', async t => {
  const w = await merged(t);
  const git = async (args, options) => (args[0] === 'push' ? { code: 0, stdout: '', stderr: '' } : runGit(args, options));
  await assert.rejects(pushVersion({ ...w.live, git }), { code: 'PUSH_UNVERIFIED' });
});

test('a push that landed before the connection dropped counts as pushed', async t => {
  const w = await merged(t);
  const git = async (args, options) => {
    const out = await runGit(args, options);
    if (args[0] === 'push') throw new Error('mất mạng');
    return out;
  };
  assert.equal((await pushVersion({ ...w.live, git })).pushed, true);
});

test('only version branch names are ever pushed, and never with force', async t => {
  const w = await merged(t);
  for (const versionBranch of ['develop', 'fix/one', 'dz/release-', 'dz/release-x', 'dz/release-1:refs/heads/develop', '+dz/release-1', 'dz/release-1..2', undefined]) {
    await assert.rejects(pushVersion({ ...w.live, versionBranch }), { code: 'INVALID' });
    await assert.rejects(ensurePr({ ...w.live, versionBranch, title: 't', body: 'b', gh: never }), { code: 'INVALID' });
  }
  const pushes = [];
  await pushVersion({ ...w.live, git: (args, options) => (args[0] === 'push' && pushes.push(args), runGit(args, options)) });
  assert.equal(pushes.length, 1);
  assert.ok(!pushes[0].some(arg => /force|^-f$|^\+|delete|mirror$/.test(arg)));
});

test('git errors never show credentials from a URL', async t => {
  const w = await merged(t);
  const githubUrl = `${w.root}/ftp://me:password1@x/ghp_abcdefABCDEF0123456789`;
  await assert.rejects(pushVersion({ ...w.live, githubUrl }), error => {
    assert.match(error.message, /ls-remote/);
    assert.doesNotMatch(error.message, /ghp_|password1/);
    return true;
  });
});

test('a dry run pull request only records what it would do', async t => {
  const w = await merged(t);
  assert.deepEqual(await ensurePr({ ...w.merge, title: 't', body: 'b', gh: never }), { number: null, url: null, created: true, dryRun: true });
  assert.deepEqual(w.records, [['would', `gh pr create --draft ${w.branch} -> develop (Apero/AAP1)`]]);
});

test('an open pull request is found and not created again', async t => {
  const w = await merged(t);
  const calls = [];
  const gh = async args => {
    calls.push(args);
    return { stdout: JSON.stringify([{ number: 5, url: 'https://github.com/Apero/AAP1/pull/5', isDraft: true }]) };
  };
  assert.deepEqual(await ensurePr({ ...w.live, title: 't', body: 'b', gh }), { number: 5, url: 'https://github.com/Apero/AAP1/pull/5', created: false });
  assert.deepEqual(calls, [['pr', 'list', '--repo', 'Apero/AAP1', '--head', w.branch, '--base', 'develop', '--state', 'open', '--json', 'number,url,isDraft']]);
});

test('a missing pull request is created as a draft from a body file that is removed afterwards', async t => {
  const w = await merged(t);
  let body;
  const gh = async args => {
    if (args[1] === 'list') return { stdout: '[]' };
    assert.deepEqual(args.slice(0, 10), ['pr', 'create', '--repo', 'Apero/AAP1', '--head', w.branch, '--base', 'develop', '--draft', '--title=--x']);
    body = args[args.indexOf('--body-file') + 1];
    assert.equal(fs.readFileSync(body, 'utf8'), 'nội dung [ẩn]');
    return { stdout: 'https://github.com/Apero/AAP1/pull/9\n' };
  };
  const out = await ensurePr({ ...w.live, title: '--x', body: 'nội dung ghp_abcdefABCDEF0123456789', gh });
  assert.deepEqual(out, { number: 9, url: 'https://github.com/Apero/AAP1/pull/9', created: true });
  assert.equal(fs.existsSync(body), false);
});

test('a created pull request whose URL was not printed is looked up, and reported if absent', async t => {
  const w = await merged(t);
  const replies = found => {
    const lists = ['[]', found];
    return async args => ({ stdout: args[1] === 'list' ? lists.shift() : '' });
  };
  const found = JSON.stringify([{ number: 3, url: 'u', isDraft: true }]);
  assert.deepEqual(await ensurePr({ ...w.live, title: 't', body: 'b', gh: replies(found) }), { number: 3, url: 'u', created: true });
  await assert.rejects(ensurePr({ ...w.live, title: 't', body: 'b', gh: replies('[]') }), { code: 'PR_UNVERIFIED' });
});
