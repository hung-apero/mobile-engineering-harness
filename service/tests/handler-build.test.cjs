const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepare, judgeBuild } = require('../src/handlers/build.cjs');
const { readSpec } = require('../src/step-spec.cjs');
const { SHA, setup, same } = require('./handlers-fixtures.cjs');

const MIN = 60000;
const GLOB = 'app/build/outputs/apk/dev/*.apk';
const step = (name, ok = true) => ({ name, ok, exitCode: ok ? 0 : 1, timedOut: false, tail: ok ? '' : 'lỗi ký' });
const VERIFY = path.join(__dirname, '..', 'src', 'verify-tree.cjs');
const built = { steps: [step('assemble')] };

function world(t) {
  const w = setup(t);
  w.project.live = true;
  w.project.commands.distribute = ['./gradlew', 'sendX'];
  const payload = { batchId: '7', worktree: w.repo, sha: SHA, distribute: true };
  const run = (extra = {}) => prepare({ payload: { ...payload, ...extra } }, { dzHome: w.dzHome, project: w.project });
  const out = path.join(w.repo, 'app/build/outputs/apk/dev');
  const apk = (name, text = 'apk', at = 1000) => {
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, name);
    fs.writeFileSync(file, text);
    fs.utimesSync(file, at, at);
    return file;
  };
  const judge = (result = built, extra = {}) => judgeBuild(result, { worktree: w.repo, apkGlob: GLOB, sha: SHA, ...extra });
  return { ...w, run, out, apk, judge, dir: path.join(w.dzHome, 'workspaces', 'AAP864', 'batches', '7', `build-${SHA.slice(0, 12)}`) };
}

const stepsIn = w => readSpec(path.join(w.dir, 'spec.json')).steps;

test('assemble runs after the tree check with one retry, alone unless distribution is asked for', t => {
  const w = world(t);
  for (const distribute of [false, undefined, 'true', 1]) {
    const out = w.run({ distribute });
    assert.equal(out.cwd, w.repo);
    assert.deepEqual(stepsIn(w).map(s => [s.name, s.argv, s.cwd, s.timeoutMs, s.retries]), [
      ['verify', [process.execPath, VERIFY, SHA], w.repo, 5 * MIN, 0], ['assemble', ['./gradlew', 'assembleX'], w.repo, 60 * MIN, 1],
    ]);
  }
});

test('distribution runs last, once and without a retry', t => {
  const w = world(t);
  w.run();
  assert.deepEqual(stepsIn(w).map(s => [s.name, s.timeoutMs, s.retries, s.once]).slice(1), [['assemble', 60 * MIN, 1, false], ['distribute', 30 * MIN, 0, true]]);
});

test('a project that is not live never distributes, even when asked', t => {
  const w = world(t);
  for (const live of [false, undefined]) {
    w.project.live = live;
    w.run();
    assert.deepEqual(stepsIn(w).map(s => s.name), ['verify', 'assemble']);
  }
});

test('asking a live project without a distribute command is an error', t => {
  const w = world(t);
  delete w.project.commands.distribute;
  assert.throws(() => w.run(), /distribute/);
  w.run({ distribute: false });
});

test('only the distribute step may see Firebase credentials, no step sees GitHub or Jira', t => {
  const w = world(t);
  const { env } = w.run();
  assert.ok(!('GOOGLE_APPLICATION_CREDENTIALS' in env));
  const [, assemble, distribute] = stepsIn(w);
  assert.equal(assemble.env.GOOGLE_APPLICATION_CREDENTIALS, null);
  assert.equal(assemble.env.FIREBASE_TOKEN, null);
  assert.deepEqual(distribute.env, {});
  for (const name of ['GITHUB_TOKEN', 'JIRA_API_TOKEN', 'SSH_AUTH_SOCK']) assert.equal(env[name], null, name);
  assert.equal(w.run({ distribute: false }).env.GOOGLE_APPLICATION_CREDENTIALS, null);
});

test('preparing again gives the same answer and bad payloads are refused', t => {
  const w = world(t);
  assert.ok(same(w.run(), w.run()));
  for (const extra of [{ sha: 'x' }, { batchId: '' }, { worktree: w.dzHome }]) assert.throws(() => w.run(extra));
});

test('a good build returns the APK with hash, size, commit and version', async t => {
  const w = world(t);
  const file = w.apk('app-dev.apk', 'nội dung');
  fs.writeFileSync(path.join(w.out, 'output-metadata.json'), JSON.stringify({ elements: [{ outputFile: 'other.apk', versionCode: 1 }, { outputFile: 'app-dev.apk', versionCode: 92, versionName: '1.9.2' }] }));
  assert.deepEqual(await w.judge(), {
    ok: true,
    apk: { path: file, sha256: crypto.createHash('sha256').update('nội dung').digest('hex'), bytes: Buffer.byteLength('nội dung'), commit: SHA, versionCode: 92, versionName: '1.9.2' },
  });
});

test('missing or broken metadata leaves the version out', async t => {
  const w = world(t);
  w.apk('app-dev.apk');
  for (const text of [null, '{', '[]', 'null', '{"elements":[null]}', '{"elements":[{"outputFile":"app-dev.apk","versionCode":"9","versionName":{}}]}']) {
    if (text !== null) fs.writeFileSync(path.join(w.out, 'output-metadata.json'), text);
    const { ok, apk } = await w.judge();
    assert.equal(ok, true);
    assert.ok(!('versionCode' in apk) && !('versionName' in apk), String(text));
  }
});

test('a build result read from the job row works too', async t => {
  const w = world(t);
  w.apk('a.apk');
  assert.equal((await w.judge({ text: JSON.stringify(built) })).ok, true);
});

test('the newest APK wins and two equally new ones are refused', async t => {
  const w = world(t);
  w.apk('old.apk', 'cũ', 1000);
  const file = w.apk('new.apk', 'mới', 2000);
  assert.equal((await w.judge()).apk.path, file);
  w.apk('twin.apk', 'mới', 2000);
  assert.equal((await w.judge()).ok, false);
});

test('no APK, an empty one or one behind a symlink is refused', async t => {
  const w = world(t);
  assert.equal((await w.judge()).ok, false);
  fs.mkdirSync(w.out, { recursive: true });
  const outside = path.join(w.dzHome, 'outside.apk');
  fs.writeFileSync(outside, 'x');
  fs.symlinkSync(outside, path.join(w.out, 'link.apk'));
  assert.equal((await w.judge()).ok, false);
  fs.rmSync(w.out, { recursive: true });
  fs.mkdirSync(path.join(w.dzHome, 'elsewhere'));
  fs.writeFileSync(path.join(w.dzHome, 'elsewhere', 'a.apk'), 'x');
  fs.symlinkSync(path.join(w.dzHome, 'elsewhere'), w.out);
  assert.equal((await w.judge()).ok, false);
  fs.unlinkSync(w.out);
  w.apk('a.apk', '');
  assert.equal((await w.judge()).ok, false);
});

test('a glob that leaves the worktree is refused', async t => {
  const w = world(t);
  w.apk('a.apk');
  for (const apkGlob of ['../**/*.apk', '/tmp/*.apk', 'app/../../x/*.apk', '', undefined]) await assert.rejects(w.judge(built, { apkGlob }), undefined, String(apkGlob));
  await assert.rejects(w.judge(built, { sha: 'x' }));
});

test('a failed step is named and a failed distribution still reports the APK', async t => {
  const w = world(t);
  const file = w.apk('a.apk');
  const red = await w.judge({ steps: [step('assemble', false)] });
  assert.deepEqual([red.ok, red.failedStep, red.apk], [false, 'assemble', undefined]);
  assert.match(red.reason, /lỗi ký/);
  const late = await w.judge({ steps: [step('assemble'), step('distribute', false)] });
  assert.deepEqual([late.ok, late.failedStep, late.apk.path], [false, 'distribute', file]);
});

test('a tree that is not the gated commit is no verdict on the code', async t => {
  const w = world(t);
  const red = await w.judge({ steps: [step('verify', false)] });
  assert.deepEqual([red.ok, red.failedStep], [false, undefined]);
  assert.match(red.reason, /verify/);
});

test('a distribution that had started before reports an unknown result', async t => {
  const w = world(t);
  w.apk('a.apk');
  const out = await w.judge({ steps: [step('verify'), step('assemble'), { ...step('distribute', false), unknown: true }] });
  assert.deepEqual([out.ok, out.failedStep, out.unknown], [false, 'distribute', true]);
});

test('an unreadable result, or one without the distribution that was asked for, never passes', async t => {
  const w = world(t);
  w.apk('a.apk');
  for (const result of [null, 'x', {}, { steps: [] }, { steps: [step('distribute')] }, { error: 'no_result' }]) assert.equal((await w.judge(result)).ok, false, JSON.stringify(result));
  assert.equal((await w.judge(built, { distribute: true })).ok, false);
  assert.equal((await w.judge({ steps: [step('assemble'), step('distribute')] }, { distribute: true })).ok, true);
});
