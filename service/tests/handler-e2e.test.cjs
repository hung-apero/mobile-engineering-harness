const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jobs = require('../src/jobs.cjs');
const { openDb, MIGRATIONS } = require('../src/db.cjs');
const { workerArgs } = require('../src/worker.cjs');
const { prepare } = require('../src/handlers/e2e.cjs');
const { parseWorker, outcomeOf } = require('../src/e2e/result.cjs');
const { startE2e } = require('../src/e2e/step.cjs');
const { setup, NOW, OK } = require('./e2e-fixtures.cjs');

async function ready(t, options) {
  const s = await setup(t, options);
  await startE2e(s.ctx, s.project, s.version(), OK, NOW);
  const { payload } = s.job();
  const state = path.join(s.dzHome, 'bug-fix-state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'devices.json'), JSON.stringify({ AAA: { holder: payload.holder, since: 0 } }));
  fs.mkdirSync(path.join(s.dzHome, 'secrets'), { recursive: true });
  const adb = path.join(s.dzHome, 'adb');
  fs.writeFileSync(adb, '#!/bin/sh\n', { mode: 0o755 });
  return { s, payload, run: (patch = {}) => prepare({ payload: { ...payload, ...patch } }, { dzHome: s.dzHome, project: s.project, adb }) };
}

test('the worker runs the pinned harness headless: no questions, no memory push, one device, no secrets', async t => {
  const { s, run } = await ready(t);
  const out = run();
  assert.match(out.prompt, /KHÔNG hỏi/);
  assert.match(out.prompt, /--skip-push/);
  assert.match(out.prompt, /Không thêm --reinstall/);
  assert.equal(out.permissionMode, 'dontAsk');
  assert.ok(out.disallowedTools.includes('AskUserQuestion'));
  assert.ok(out.disallowedTools.some(rule => rule.includes('/secrets/')));
  assert.ok(!out.allowedTools.includes('Bash'));
  assert.ok(out.allowedTools.includes('Bash(adb -s AAA:*)'));
  assert.deepEqual(out.pluginDirs, [path.join(s.dzHome, 'android-test-harness')]);
  assert.equal(out.env.ANDROID_SERIAL, 'AAA');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(out.mcpConfig, 'utf8')).mcpServers), ['maestro']);
  assert.ok(!out.mcpConfig.startsWith(out.cwd + path.sep));
  const args = workerArgs({ ...out, sessionId: 'x' });
  assert.ok(args.includes('--strict-mcp-config') && !args.includes('bypassPermissions'));
});

test('the worker may read only the app root, the harness and the test case file', async t => {
  const { s, payload, run } = await ready(t);
  const out = run();
  const reads = out.allowedTools.filter(rule => /^(?:Read|Glob|Grep)\b/.test(rule));
  const root = fs.realpathSync(payload.root);
  const harness = path.join(s.dzHome, 'android-test-harness');
  const file = payload.testCases.kind === 'sheet' ? [] : [`Read(/${payload.testCases.value})`];
  assert.deepEqual(reads, [`Read(/${root}/**)`, `Read(/${harness}/**)`, ...file]);
  assert.equal(out.permissionMode, 'dontAsk');
});

test('a retried E2E job without the device lock refuses to start', async t => {
  const { s, run } = await ready(t);
  fs.writeFileSync(path.join(s.dzHome, 'bug-fix-state', 'devices.json'), '{}');
  assert.throws(() => run(), /khoá thiết bị/);
});

test('payload paths outside the project, odd serials and unknown sources are refused', async t => {
  const { run } = await ready(t);
  for (const patch of [{ apk: '/etc/hosts' }, { root: '/tmp' }, { serial: 'a;b' }, { testCases: { kind: 'spec', value: '/etc/hosts' } }, { testCases: { kind: 'x', value: 'y' } }, { apkSha256: 'x' }]) {
    assert.throws(() => run(patch), undefined, JSON.stringify(patch));
  }
});

test('an app that is not on the store skips the upgrade; with a store APK a blocked upgrade is not a pass', () => {
  const pass = [{ id: 'TC-1', status: 'pass' }];
  assert.equal(outcomeOf({ upgrade: { status: 'none' } }, pass, null).status, 'pass');
  assert.deepEqual(outcomeOf({ upgrade: { status: 'blocked' } }, pass, '/s.apk').incomplete, ['NANG-CAP']);
  assert.equal(outcomeOf({ upgrade: { status: 'none' } }, pass, '/s.apk').status, 'fail');
});

test('a malformed worker result is refused', () => {
  for (const doc of ['không phải json', { status: 'done' }, { status: 'done', round: 1, reason: '', upgrade: { status: 'ok', reason: '' } }, { status: 'done', round: 1.5, reason: '', upgrade: { status: 'pass', reason: '' } }]) assert.equal(parseWorker(doc).ok, false);
});

test('migration: e2e and uidiff jobs are accepted and older jobs keep their rows', t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dz-e2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(dir, 'dz.db'));
  const before = MIGRATIONS.findIndex(sql => sql.includes("'uidiff'"));
  for (const sql of MIGRATIONS.slice(0, before)) raw.exec(sql);
  raw.exec(`INSERT INTO jobs (id, project, kind, key, priority, slots, created_at) VALUES (9, 'A', 'spec', 'k', 1, 1, 5); PRAGMA user_version = ${before}`);
  raw.close();
  const db = openDb(path.join(dir, 'dz.db'));
  assert.equal(jobs.getJob(db, 9).kind, 'spec');
  for (const kind of ['e2e', 'uidiff']) assert.equal(jobs.enqueue(db, { project: 'A', kind, key: '1', priority: 1, slots: 1 }, NOW).created, true);
});
