const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepare } = require('../src/handlers/spec.cjs');
const { setup, SHA, LANE_SHA } = require('./handlers-fixtures.cjs');

const SERIAL = 'emulator-5554';

function make(t) {
  const w = setup(t);
  const repo = path.join(w.dzHome, 'workspaces', 'AAP864', 'specs', '7', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const options = extra => ({ dzHome: w.dzHome, project: w.project, adb: '/usr/bin/true', ...extra });
  const job = (payload, extra) => ({ slotsGranted: 2, payload: { specId: 7, repo, ...payload }, ...extra });
  const lock = entry => {
    fs.mkdirSync(path.join(w.dzHome, 'bug-fix-state'), { recursive: true });
    fs.writeFileSync(path.join(w.dzHome, 'bug-fix-state', 'devices.json'), JSON.stringify({ [SERIAL]: entry }));
  };
  return { ...w, specRepo: repo, options, job, lock };
}

test('the code worker runs the harness headless, with no push and no device', t => {
  const w = make(t);
  const out = prepare(w.job({ segment: 'build', branch: 'dz/spec-7' }), w.options());
  assert.equal(out.env.HARNESS_HEADLESS, '1');
  assert.deepEqual([out.env.LEARN_APP_PARALLEL, out.env.LEARN_APP_HEADLESS, out.env.ANDROID_SERIAL], [undefined, undefined, undefined]);
  assert.deepEqual(out.pluginDirs, []);
  for (const rule of ['Bash(adb:*)', 'Bash(emulator:*)', 'Bash(git push:*)', 'Bash(gh:*)', 'Bash(*platform-tools/adb*)']) assert.ok(out.disallowedTools.includes(rule), rule);
  assert.notEqual(out.permissionMode, 'bypassPermissions');
  assert.throws(() => prepare(w.job({ segment: 'build', branch: 'main' }), w.options()), /payload\.branch/);
});

test('the smoke worker runs only on the device it still holds', t => {
  const w = make(t);
  const job = w.job({ segment: 'smoke', serial: SERIAL, holder: 'spec:7:run' });
  assert.throws(() => prepare(job, w.options()), /không còn giữ khoá/);
  w.lock({ holder: 'spec:8:run' });
  assert.throws(() => prepare(job, w.options()), /không còn giữ khoá/);
  w.lock({ holder: 'spec:7:run' });
  const out = prepare(job, w.options());
  assert.equal(out.env.ANDROID_SERIAL, SERIAL);
  assert.notEqual(out.env.PATH.split(path.delimiter)[0], process.env.PATH.split(path.delimiter)[0]);
  assert.ok(!out.disallowedTools.includes('Bash(adb:*)'));
  assert.ok(out.disallowedTools.includes('Bash(*platform-tools/adb*)'));
  assert.throws(() => prepare(w.job({ segment: 'smoke', serial: SERIAL, holder: 'spec:8:run' }), w.options()), /không còn giữ khoá/);
  assert.throws(() => prepare(job, w.options({ project: { ...w.project, excludedDevices: [SERIAL] } })), /serial/);
});

test('the review worker reads one commit, with a schema and no write tools', t => {
  const w = make(t);
  const repo = path.join(w.dzHome, 'workspaces', 'AAP864', 'batches', 'spec-7', 'review');
  fs.mkdirSync(repo, { recursive: true });
  const specFile = path.join(path.dirname(repo), 'spec.md');
  fs.writeFileSync(specFile, '# Spec\n');
  const job = extra => ({ payload: { specId: 7, type: 'review', repo, specFile, startSha: SHA, sha: LANE_SHA, title: 'x', ...extra } });
  const out = prepare(job(), w.options());
  assert.deepEqual([out.permissionMode, out.model], ['dontAsk', 'opus']);
  assert.ok(out.allowedTools.every(rule => /^(Read|Grep|Glob|Bash\(git (log|show|diff|blame):\*\))$/.test(rule)));
  assert.ok(out.jsonSchema.required.includes('verdict'));
  assert.match(out.prompt, new RegExp(`${SHA} ${LANE_SHA}`));
  fs.symlinkSync('/etc/hosts', path.join(path.dirname(repo), 'link.md'));
  for (const bad of [{ specFile: '/etc/hosts' }, { specFile: path.join(path.dirname(repo), 'link.md') }, { sha: 'HEAD' }, { startSha: '--output=x' }, { repo: '/etc' }]) assert.throws(() => prepare(job(bad), w.options()), JSON.stringify(bad));
});
