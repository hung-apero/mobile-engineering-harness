const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kv = require('../src/kv.cjs');
const { startE2e, settleRuns } = require('../src/e2e/step.cjs');
const { sixthCondition } = require('../src/e2e/state.cjs');
const { acceptE2e } = require('../src/e2e/qa.cjs');
const { prepare } = require('../src/handlers/e2e.cjs');
const { loadProjects } = require('../src/projects.cjs');
const { yamlFor } = require('./projects-fixtures.cjs');
const { setup, writeInputs, NOW, VERSION, OK } = require('./e2e-fixtures.cjs');

const HOUR = 3600000;
const start = (s, now = NOW) => startE2e(s.ctx, s.project, s.version(), OK, now);
const settle = (s, now = NOW) => settleRuns(s.ctx, s.project, now);
const six = s => sixthCondition(s.ctx, s.project, s.version());

test('F2: a report that leaves out cases of ts-index or of the test-cases folder is not a result', async t => {
  const s = await setup(t);
  await start(s);
  s.finish({ expected: ['TC-1', 'TC-2'] });
  await settle(s);
  assert.equal(s.state().result, null);
  await start(s, NOW + HOUR);
  s.finish({});
  const dir = path.join(s.job().payload.root, '.android-app', 'test-cases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TC-9.md'), 'x');
  await settle(s, NOW + HOUR);
  assert.equal((await six(s)).ok, null);
  assert.match(s.waits('dev').join(), /TC-9/);
});

test('F2: no list of cases at all is blocked', async t => {
  const s = await setup(t);
  await start(s);
  s.finish({ expected: [] });
  await settle(s);
  assert.equal(s.state().result, null);
});

for (const [name, journal] of [
  ['never installed the store APK', ({ apk }) => [{ verb: 'install', apk, update: true, ok: true }]],
  ['uninstalled in between', ({ storeApk, apk }) => [{ verb: 'install', apk: storeApk, ok: true }, { verb: 'uninstall', ok: true }, { verb: 'install', apk, update: true, ok: true }]],
  ['only failed to install', ({ storeApk, apk }) => [{ verb: 'install', apk: storeApk, ok: true }, { verb: 'install', apk, update: true, ok: false }]],
]) {
  test(`F2: upgrade.status pass is not believed when the worker ${name}`, async t => {
    const s = await setup(t);
    await start(s);
    s.finish({ journal });
    await settle(s);
    assert.deepEqual(s.state().result.incomplete, ['NANG-CAP']);
    assert.equal((await six(s)).ok, false);
  });
}

test('F3: without e2eDevices E2E waits and runs nothing, also in live', async t => {
  for (const live of [false, true]) {
    for (const e2eDevices of [undefined, []]) {
      const s = await setup(t, { live });
      s.project.e2eDevices = e2eDevices;
      assert.equal(await start(s), false);
      assert.match(s.waits('dev')[0], /e2eDevices/);
      assert.deepEqual([s.job(), s.locks.length], [undefined, 0]);
    }
  }
});

test('F3: a dry project touches no device unless its E2E config says dryRun: true', async t => {
  const s = await setup(t);
  writeInputs(s, { dryRun: undefined });
  assert.equal(await start(s), false);
  assert.deepEqual([s.locks.length, s.waits('dev').length], [0, 0]);
  fs.rmSync(path.join(s.dzHome, 'e2e', 'AAP1.json'));
  assert.equal(await start(s), false);
  writeInputs(s, { dryRun: true });
  assert.equal(await start(s, NOW + 1), true);
  const live = await setup(t, { live: true });
  writeInputs(live, { dryRun: undefined });
  assert.equal(await start(live), true);
});

test('F3: an app that was on the device before us is left alone unless reinstall is true', async t => {
  const s = await setup(t);
  s.packages.AAA = { present: true, lastUpdate: '2026-01-01' };
  assert.equal(await start(s), false);
  assert.match(s.waits('dev').join(), /com\.example\.app.*AAA.*reinstall/);
  assert.equal(s.locks.at(-1)[0], 'release');
  assert.equal(s.job(), undefined);
  writeInputs(s, { reinstall: true });
  assert.equal(await start(s, NOW + 1), true);
});

test('F3: our own install from an earlier round is not a foreign app, until somebody else updates it', async t => {
  const s = await setup(t);
  await start(s);
  s.packages.AAA = { present: true, lastUpdate: 'ours' };
  s.finish({ status: 'blocked', reason: 'mất máy' });
  await settle(s);
  assert.equal(await start(s, NOW + HOUR), true);
  s.finish({ status: 'blocked', reason: 'mất máy' });
  await settle(s, NOW + HOUR);
  s.packages.AAA = { present: true, lastUpdate: 'theirs' };
  kv.set(s.db, `e2e:AAP1:${VERSION}`, { ...s.state(), blocked: null }, NOW);
  assert.equal(await start(s, NOW + 2 * HOUR), false);
});

async function ready(t, options) {
  const s = await setup(t, options);
  await start(s);
  const { payload } = s.job();
  const state = path.join(s.dzHome, 'bug-fix-state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'devices.json'), JSON.stringify({ AAA: { holder: payload.holder, since: 0 } }));
  const adb = path.join(s.dzHome, 'adb');
  fs.writeFileSync(adb, '#!/bin/sh\n', { mode: 0o755 });
  return { s, payload, run: (project = s.project) => prepare({ payload }, { dzHome: s.dzHome, project, adb }) };
}

test('F3: the worker refuses a device outside e2eDevices, an excluded one, and a dry project', async t => {
  const { s, run } = await ready(t);
  for (const e2eDevices of [undefined, [], ['BBB']]) assert.throws(() => run({ ...s.project, e2eDevices }), /e2eDevices/);
  assert.throws(() => run({ ...s.project, excludedDevices: ['AAA'] }), /e2eDevices/);
  writeInputs(s, { dryRun: false });
  assert.throws(() => run(), /chạy khô/);
});

test('F4: the worker finds only the shim: ANDROID_HOME, PATH, Maestro and replay are the service guards', async t => {
  const { s, payload, run } = await ready(t);
  const out = run();
  assert.equal(out.env.ANDROID_HOME, out.env.ANDROID_SDK_ROOT);
  assert.equal(out.env.PATH.split(':')[0], path.join(out.env.ANDROID_HOME, 'platform-tools'));
  assert.ok(fs.existsSync(path.join(out.env.ANDROID_HOME, 'platform-tools', 'adb')));
  assert.ok(!out.env.ANDROID_HOME.startsWith(payload.root + path.sep));
  const { maestro } = JSON.parse(fs.readFileSync(out.mcpConfig, 'utf8')).mcpServers;
  assert.match(maestro.args[0], /maestro-proxy\.cjs$/);
  assert.ok(!out.allowedTools.some(rule => rule.includes('bin/replay.cjs')));
  assert.ok(out.allowedTools.some(rule => rule.includes('replay-guard.cjs')));
  assert.ok(out.disallowedTools.includes('Bash(*--remote-config-url*)'));
  assert.ok(s.project.key);
});

test('F5: the worker reads only its root, the harness and its inputs, and cannot write the report', async t => {
  const { s, payload, run } = await ready(t);
  const { allowedTools, disallowedTools } = run();
  const home = fs.realpathSync(s.dzHome);
  assert.deepEqual(allowedTools.filter(rule => /^(Read|Grep|Glob|Write|Edit)/.test(rule)), [
    `Read(/${payload.root}/**)`, `Read(/${home}/android-test-harness/**)`, `Read(/${home}/e2e/spec.md)`, `Edit(/${payload.root}/**)`,
  ]);
  assert.ok(disallowedTools.includes(`Edit(/${payload.root}/.android-app/rounds/*/report.json)`));
  assert.ok(disallowedTools.includes(`Edit(/${payload.root}/.claude/**)`));
  assert.ok(disallowedTools.includes(`Read(/${home}/secrets/**)`));
});

test('e2eDevices is an optional list of serials', t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dz-e2edev-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'workspaces', 'AAP1'), { recursive: true });
  const load = extra => {
    fs.writeFileSync(path.join(dir, 'AAP1.yaml'), yamlFor('AAP1', dir, extra));
    const { projects, errors } = loadProjects(dir, { dzHome: dir });
    return errors[0]?.message ?? projects.get('AAP1').e2eDevices;
  };
  assert.equal(load({}), undefined);
  assert.deepEqual(load({ e2eDevices: ['AAA', 'emulator-5554'] }), ['AAA', 'emulator-5554']);
  for (const bad of ['AAA', ['a b'], [5], ['-s']]) assert.match(load({ e2eDevices: bad }), /e2eDevices/);
});

test('Minor: accepting E2E saves before it comments, and a lost comment is posted once on retry', async t => {
  const s = await setup(t, { live: true });
  s.db.prepare("INSERT INTO batches (project, version, kind, state, keys, data, opened_at, updated_at) VALUES ('AAP1', ?, 'normal', 'done', '[]', ?, 1, 1)").run(VERSION, JSON.stringify({ pr: { number: 7, url: 'u' } }));
  await start(s);
  s.finish({ cases: [{ id: 'TC-1', status: 'fail', reason: 'x' }] });
  await settle(s);
  const posted = [];
  let down = true;
  s.ctx.bugs.gh = async args => {
    if (args[1] === 'view') return { stdout: JSON.stringify({ comments: posted.map(body => ({ body })) }) };
    if (down) throw new Error('502');
    posted.push(fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'));
    return { stdout: '' };
  };
  const accept = () => acceptE2e(s.ctx, s.project, s.version(), { by: 'Lan' }, NOW);
  await assert.rejects(accept(), /502/);
  assert.equal((await six(s)).ok, true);
  down = false;
  await accept();
  assert.equal(posted.length, 1);
  kv.set(s.db, `e2e:AAP1:${VERSION}`, { ...s.state(), result: { ...s.state().result, accepted: { ...s.state().result.accepted, posted: false } } }, NOW);
  await accept();
  assert.equal(posted.length, 1);
  await assert.rejects(accept(), /không có kết quả E2E lỗi/);
});
