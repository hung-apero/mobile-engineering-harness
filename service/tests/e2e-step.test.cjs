const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assess } = require('../src/bugs/release.cjs');
const { settleRuns, startE2e } = require('../src/e2e/step.cjs');
const { sixthCondition } = require('../src/e2e/state.cjs');
const { acceptE2e, continueE2e } = require('../src/e2e/qa.cjs');
const { setup, writeInputs, treeOf, NOW, VERSION, OK } = require('./e2e-fixtures.cjs');

const HOUR = 3600000;
const start = (s, now = NOW, assessed = OK) => startE2e(s.ctx, s.project, s.version(), assessed, now);
const settle = (s, now = NOW) => settleRuns(s.ctx, s.project, now);
const six = s => sixthCondition(s.ctx, s.project, s.version());
const fail = { cases: [{ id: 'TC-1', status: 'fail', reason: 'màn trắng', expect: 'có danh sách' }, { id: 'TC-2', status: 'pass' }] };

async function round(s, options, now = NOW) {
  assert.equal(await start(s, now), true);
  s.finish(options);
  return settle(s, now);
}

function commitMore(s, name) {
  const lane = s.lane(`fix/${name}`, { [`${name}.txt`]: `${name}\n` });
  return require('../src/bugs/merge.cjs').mergeBatch({ ...s.merge, startSha: s.startSha, branches: [{ branch: `fix/${name}`, commit: lane }] });
}

test('E2E is queued once with the build, tree and locked device when 2-5 hold, the version is closed and a build exists', async t => {
  const s = await setup(t);
  assert.equal(await start(s), true);
  assert.equal(await start(s), false);
  const { payload, key, slots } = s.job();
  assert.deepEqual([key, slots, payload.serial, payload.tree], [`${VERSION}#1`, 1, 'AAA', await treeOf({ dzHome: s.dzHome, project: s.project, sha: s.ref(s.branch) })]);
  assert.equal(fs.existsSync(payload.apk), true);
  assert.deepEqual(s.locks.at(-1), ['acquire', 'AAA', 'spec:e2e-AAP1-1-9-2:run']);
});

for (const [name, options, assessed] of [
  ['the version is still open for features', { closed: false }, OK],
  ['there is no build', { build: false }, OK],
  ['one of conditions 2-5 is false', {}, { conditions: OK.conditions.map((c, i) => (i === 3 ? { ...c, ok: false } : c)) }],
  ['one of conditions 2-5 is unknown', {}, { conditions: OK.conditions.map((c, i) => (i === 1 ? { ...c, ok: null } : c)) }],
]) {
  test(`E2E is not queued when ${name}`, async t => {
    const s = await setup(t, options);
    assert.equal(await start(s, NOW, assessed), false);
    assert.equal(s.job(), undefined);
  });
}

test('E2E is not queued when the build is of another tree than the version tip', async t => {
  const s = await setup(t);
  await commitMore(s, 'one');
  assert.equal(await start(s), false);
  await s.addBuild(2);
  assert.equal(await start(s), true);
});

test('F05: no device means no run and one dev wait, closed once a device is there', async t => {
  const s = await setup(t, { device: null });
  for (const at of [NOW, NOW + 1]) assert.equal(await start(s, at), false);
  assert.equal(s.job(), undefined);
  assert.match(s.waits('dev')[0], /F05/);
  assert.deepEqual(s.actions('F05'), ['e2e-no-device']);
  s.device = 'AAA';
  assert.equal(await start(s, NOW + 2), true);
  assert.deepEqual(s.waits('dev'), []);
});

test('missing inputs are named in a dev wait and nothing runs', async t => {
  const s = await setup(t, { inputs: false, live: true });
  assert.equal(await start(s), false);
  assert.match(s.waits('dev')[0], /android-test-harness/);
  writeInputs(s, { storeApk: undefined, testCases: { kind: 'sheet', value: 'http://evil/' } });
  fs.writeFileSync(path.join(s.dzHome, 'e2e', 'AAP1.json'), '{"testCases":{"kind":"csv","value":"/etc/passwd"}}');
  assert.equal(await start(s, NOW + 1), false);
  assert.equal(s.locks.length, 0);
});

test('a passing E2E makes condition 6 true for that tree, releases the device, and a new tree makes it unknown', async t => {
  const s = await setup(t);
  assert.deepEqual(await round(s, {}), [VERSION]);
  assert.equal((await six(s)).ok, true);
  assert.deepEqual(s.locks.at(-1), ['release', 'spec:e2e-AAP1-1-9-2:']);
  assert.equal(await start(s, NOW + 1), false);
  await commitMore(s, 'one');
  assert.deepEqual(await six(s), { ok: null, detail: 'chưa có' });
  assert.equal((await assess({ ...s.ctx, bugs: { ...s.ctx.bugs, baseContains: async () => ({ ok: true }) } }, s.project, s.version(), NOW)).conditions[5].ok, null);
});

test('a different commit with the same tree keeps the E2E result', async t => {
  const s = await setup(t);
  await round(s, {});
  const { g } = require('./bugs-git-fixtures.cjs');
  const tip = s.ref(s.branch);
  const same = g(s.mirror, 'commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'same tree');
  g(s.mirror, 'update-ref', `refs/heads/${s.branch}`, same);
  assert.equal((await six(s)).ok, true);
});

test('a dry failure records would and creates no ticket', async t => {
  const s = await setup(t);
  await round(s, fail);
  assert.equal((await six(s)).ok, false);
  assert.equal(s.ticketCalls.length, 0);
  assert.deepEqual(s.actions('DRY'), ['would']);
  assert.deepEqual(s.waits('qa'), []);
});

test('a live failure creates one High Bug per failing case and nothing for environment failures', async t => {
  const s = await setup(t, { live: true });
  await round(s, { cases: [...fail.cases, { id: 'TC-3', status: 'fail', triage: { class: 'env' } }], upgrade: { status: 'fail', reason: 'mất dữ liệu' } });
  assert.deepEqual(s.ticketCalls.map(c => [c.priority, c.summary.slice(0, 14)]), [['High', 'E2E 1.9.2: TC-'], ['High', 'E2E 1.9.2: NAN']]);
  assert.deepEqual(s.state().result.tickets, ['AAP1-101', 'AAP1-102']);
  assert.deepEqual(s.state().result.incomplete, ['TC-3']);
});

test('S06: the second failed round asks QA and stops; accept on the same tree counts as E2E pass', async t => {
  const s = await setup(t);
  await round(s, fail);
  await commitMore(s, 'one');
  await s.addBuild(2);
  await round(s, fail, NOW + HOUR);
  assert.match(s.waits('qa')[0], /S06/);
  assert.deepEqual(s.actions('S06').filter(a => a === 'ask-qa'), ['ask-qa']);
  await commitMore(s, 'two');
  await s.addBuild(3);
  assert.equal(await start(s, NOW + 2 * HOUR), false);
  await assert.rejects(acceptE2e(s.ctx, s.project, s.version(), { by: 'Lan' }, NOW), /không có kết quả E2E lỗi/);
  continueE2e(s.ctx, s.project, s.version(), { by: 'Lan' }, NOW);
  assert.deepEqual(s.waits('qa'), []);
  await round(s, fail, NOW + 3 * HOUR);
  await acceptE2e(s.ctx, s.project, s.version(), { by: 'Lan' }, NOW);
  assert.equal((await six(s)).ok, true);
  assert.match((await six(s)).detail, /Lan/);
  assert.equal(s.gh.length, 0);
});

test('S06: an accepted E2E is written to the live PR', async t => {
  const s = await setup(t, { live: true });
  s.ctx.bugs.gh = async args => ({ stdout: s.gh.push(args) ? '{}' : '' });
  s.db.prepare("INSERT INTO batches (project, version, kind, state, keys, data, opened_at, updated_at) VALUES ('AAP1', ?, 'normal', 'done', '[]', ?, 1, 1)").run(VERSION, JSON.stringify({ pr: { number: 7, url: 'https://github.com/Apero/AAP1/pull/7' } }));
  await round(s, fail);
  await acceptE2e(s.ctx, s.project, s.version(), { by: 'Lan' }, NOW);
  assert.deepEqual(s.gh.filter(args => args[1] === 'comment').map(args => args.slice(0, 3)), [['pr', 'comment', '7']]);
});

test('only skipped or unrunnable cases go to QA at once because no fix can help', async t => {
  const s = await setup(t);
  await round(s, { cases: [{ id: 'TC-1', status: 'pass' }, { id: 'TC-2', status: 'cannot_execute' }] });
  assert.deepEqual([s.waits('qa').length, (await six(s)).ok], [1, false]);
});

test('a blocked run is not a round: it is retried an hour later, then handed to dev', async t => {
  const s = await setup(t);
  await round(s, { state: 'parked' });
  assert.equal(s.job().state, 'failed');
  assert.equal((await six(s)).ok, null);
  assert.equal(await start(s, NOW + HOUR - 1), false);
  await round(s, { status: 'blocked', reason: 'mất máy' }, NOW + HOUR);
  assert.match(s.waits('dev')[0], /không chạy được 2 lần: mất máy/);
  assert.equal(await start(s, NOW + 9 * HOUR), false);
  assert.equal(s.state().failedRounds, 0);
});

test('a report older than the run, or a build changed during the run, is blocked and never a pass', async t => {
  const s = await setup(t);
  await start(s);
  s.finish();
  s.db.prepare('UPDATE jobs SET started_at = ?').run(Date.now() + HOUR);
  await settle(s);
  assert.equal(s.state().result, null);
  await start(s, NOW + HOUR);
  s.finish();
  fs.writeFileSync(s.job().payload.apk, 'khác');
  await settle(s, NOW + HOUR);
  assert.equal(s.state().result, null);
});

test('Jira refusing to create tickets keeps the run unsettled, with the device free, and retries later', async t => {
  const s = await setup(t, { live: true });
  let down = true;
  const { ticketClient } = s.ctx.e2e;
  s.ctx.e2e.ticketClient = () => (down ? { create: async () => { throw new Error('502'); }, close: async () => {} } : ticketClient());
  await start(s);
  s.finish(fail);
  await assert.rejects(settle(s), /502/);
  assert.equal(s.locks.at(-1)[0], 'release');
  assert.deepEqual(await settle(s, NOW + 1000), []);
  down = false;
  assert.deepEqual(await settle(s, NOW + 5 * 60000), [VERSION]);
  assert.equal(s.ticketCalls.length, 1);
});

test('a paused project starts nothing', async t => {
  const s = await setup(t);
  require('../src/health.cjs').setProjectState(s.db, 'AAP1', { paused: true });
  assert.equal(await start(s), false);
});
