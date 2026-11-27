const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkDiff } = require('../src/bugs/diff-guard.cjs');
const { checkLane } = require('../src/bugs/lane-check.cjs');
const { g, put, commit, world, readyWorld } = require('./bugs-git-fixtures.cjs');

const TOKEN = 'ghp_abcdefABCDEF0123456789abcd';

async function guard(t, files, options = {}) {
  const w = await readyWorld(t);
  const to = w.lane('fix/x', files);
  return checkDiff({ ...w.ctx, from: w.startSha, to, ...options });
}
const codes = out => out.problems.map(p => [p.code, p.file]);

test('an ordinary change passes with its size', async t => {
  assert.deepEqual(await guard(t, { 'a.txt': 'x\ny\n', 'src/A.kt': 'this@Main.run()\nval mail = "a@b.com"\n' }), { ok: true, problems: [], lines: 5, files: 2 });
});

test('every forbidden area is reported, at any depth and in any letter case', async t => {
  const files = [
    '.github/workflows/x.yml', 'Jenkinsfile', 'app/release.jks', 'x.keystore', 'app/src/dev/google-services.json',
    'a/my-service-account-dev.json', 'gradle/wrapper/gradle-wrapper.properties', 'RULES/a.yaml',
  ];
  const out = await guard(t, Object.fromEntries(files.map(name => [name, 'x\n'])));
  assert.equal(out.ok, false);
  assert.deepEqual(codes(out).sort(), files.map(name => ['forbidden', name]).sort());
});

test('a force added .claude file is reported', async t => {
  const w = await readyWorld(t);
  put(w.repo, { '.claude/settings.json': '{}\n' });
  g(w.repo, 'add', '-f', '.claude/settings.json');
  const to = w.lane('fix/x', {});
  assert.deepEqual(codes(await checkDiff({ ...w.ctx, from: w.startSha, to })), [['forbidden', '.claude/settings.json']]);
});

test('names close to a forbidden area are allowed', async t => {
  const out = await guard(t, { 'docs/Jenkinsfile.md': 'x\n', 'app/rules/a.txt': 'x\n', 'gradle/libs.toml': 'x\n', 'xjks': 'x\n', 'github/a': 'x\n' });
  assert.deepEqual(out.problems, []);
});

test('project areas are added to the default ones', async t => {
  const out = await guard(t, { 'billing/x/A.kt': 'x\n', 'Jenkinsfile': 'x\n', 'other.kt': 'x\n' }, { forbidden: ['billing/**'] });
  assert.deepEqual(codes(out), [['forbidden', 'Jenkinsfile'], ['forbidden', 'billing/x/A.kt']]);
});

test('a local build file of the project is refused even when the caller passes its own areas', async t => {
  const w = await readyWorld(t);
  const project = { ...w.ctx.project, localFiles: ['keys.json', 'app/google-services.json'] };
  const to = w.lane('fix/x', { 'keys.json': '{}\n', 'app/google-services.json': '{}\n', 'app/keys.json': 'b\n' });
  const out = await checkDiff({ ...w.ctx, project, from: w.startSha, to, forbidden: ['billing/**'] });
  assert.deepEqual(out.problems.map(p => [p.code, p.file, p.local]), [['forbidden', 'app/google-services.json', true], ['forbidden', 'keys.json', true]]);
});

test('a local build file added then removed inside a bug lane is refused', async t => {
  const w = await readyWorld(t);
  const project = { ...w.ctx.project, localFiles: ['keys.json'] };
  const first = w.lane('fix/x', { 'keys.json': '{}\n', 'a.txt': 'x\n' });
  fs.rmSync(path.join(w.repo, 'keys.json'));
  g(w.repo, 'commit', '-q', '-am', 'bo');
  const last = g(w.repo, 'rev-parse', 'HEAD').trim();
  g(w.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/fix/x');
  const landing = { laneState: async () => ({ ok: true, commits: [{ sha: first, parent: w.startSha }, { sha: last, parent: first }] }) };
  const run = { ctx: { dzHome: w.ctx.dzHome, bugs: { git: { landing, diffGuard: { checkDiff } } } }, project, live: false, batch: { data: { startSha: w.startSha } } };
  const out = await checkLane(run, { branch: 'fix/x', commit: last });
  assert.deepEqual([out.kind, out.text.includes('keys.json')], ['forbidden', true]);
});

test('deleting or renaming away a forbidden file is reported', async t => {
  const w = world(t);
  const from = commit(w.dev, { 'Jenkinsfile': 'a\nb\nc\nd\n' });
  const to = commit(w.dev, { 'Jenkinsfile': null, 'moved.txt': 'a\nb\nc\nd\n' });
  fs.mkdirSync(path.dirname(w.mirror), { recursive: true });
  g(w.root, 'clone', '-q', '--bare', w.dev, w.mirror);
  assert.deepEqual(codes(await checkDiff({ ...w.ctx, from, to })), [['forbidden', 'Jenkinsfile']]);
});

test('a manifest is reported only when an added line asks for a permission', async t => {
  const w = await readyWorld(t);
  const name = 'app/src/main/AndroidManifest.xml';
  const first = w.lane('fix/a', { [name]: '<manifest>\n<uses-permission android:name="A"/>\n</manifest>\n' });
  assert.deepEqual(codes(await checkDiff({ ...w.ctx, from: w.startSha, to: first })), [['permission', name]]);
  const second = commit(w.repo, { [name]: '<manifest>\n<application/>\n</manifest>\n' });
  g(w.repo, 'push', '-q', 'origin', `${second}:refs/heads/fix/b`);
  assert.deepEqual((await checkDiff({ ...w.ctx, from: first, to: second })).problems, []);
});

test('a secret on an added line is reported without showing it', async t => {
  const out = await guard(t, { 'src/A.kt': `val a = 1\nval t = "${TOKEN}"\n`, 'k.pem': '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n' });
  assert.ok(codes(out).some(([code, file]) => code === 'secret' && file === 'src/A.kt'));
  assert.doesNotMatch(JSON.stringify(out), /ghp_/);
});

test('a secret in a file name is reported without showing it', async t => {
  const out = await guard(t, { [`${TOKEN}.txt`]: 'x\n' });
  assert.deepEqual(codes(out), [['secret', '[ẩn].txt']]);
});

test('a secret already there, or on a removed line, is not reported', async t => {
  const w = await readyWorld(t);
  const from = w.lane('fix/a', { 'old.txt': `${TOKEN}\nx\n` });
  const to = commit(w.repo, { 'old.txt': 'x\ny\n' });
  g(w.repo, 'push', '-q', 'origin', `${to}:refs/heads/fix/b`);
  assert.deepEqual((await checkDiff({ ...w.ctx, from, to })).problems, []);
});

test('secrets hide neither behind attributes nor behind odd file names', async t => {
  const names = ['a b.txt', 'tab\there.txt', 'việt "x".txt', ':(top)x.txt', '-n', '*.txt', '+++ b.txt'];
  const out = await guard(t, { '.gitattributes': '* binary -diff\n', ...Object.fromEntries(names.map(name => [name, `${TOKEN}\n`])) });
  assert.deepEqual(codes(out).map(c => c[1]).sort(), [...names].sort());
});

test('lines that look like diff headers are still read as content', async t => {
  const out = await guard(t, { 'a.txt': `a\n++ ${TOKEN}\n@@ x\n` });
  assert.deepEqual(codes(out), [['secret', 'a.txt']]);
});

test('a symlink is reported', async t => {
  assert.deepEqual(codes(await guard(t, { 'link': { symlinkTo: '/etc/passwd' } })), [['symlink', 'link']]);
});

test('a submodule and .gitmodules are reported', async t => {
  const w = await readyWorld(t);
  g(w.repo, 'update-index', '--add', '--cacheinfo', `160000,${w.startSha},sub`);
  put(w.repo, { '.gitmodules': '[submodule "sub"]\n' });
  g(w.repo, 'add', '.gitmodules');
  g(w.repo, 'commit', '-qm', 'sub');
  const to = g(w.repo, 'rev-parse', 'HEAD');
  g(w.repo, 'push', '-q', 'origin', `${to}:refs/heads/fix/sub`);
  assert.deepEqual(codes(await checkDiff({ ...w.ctx, from: w.startSha, to })), [['submodule', '.gitmodules'], ['submodule', 'sub']]);
});

test('only a binary over one megabyte is reported', async t => {
  const out = await guard(t, { 'small.webp': Buffer.alloc(1024 * 1024), 'big.webp': Buffer.alloc(1024 * 1024 + 1) });
  assert.deepEqual(codes(out), [['big_binary', 'big.webp']]);
});

test('more than 1500 changed lines is reported, 1500 is not', async t => {
  const w = await readyWorld(t);
  const at = n => w.lane(`fix/n${n}`, { 'long.txt': 'x\n'.repeat(n) });
  assert.equal((await checkDiff({ ...w.ctx, from: w.startSha, to: at(1500) })).ok, true);
  assert.deepEqual(codes(await checkDiff({ ...w.ctx, from: w.startSha, to: at(1501) })), [['too_large', null]]);
});

test('anything but two full commit ids that exist is an error', async t => {
  const w = await readyWorld(t);
  for (const to of ['HEAD', '--output=x', undefined, 'abc']) await assert.rejects(checkDiff({ ...w.ctx, from: w.startSha, to }), { code: 'INVALID' });
  await assert.rejects(checkDiff({ ...w.ctx, from: w.startSha, to: '1'.repeat(40) }));
});
