const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { openWait } = require('../src/pings.cjs');
const { assess, checkRelease, releaseKey } = require('../src/bugs/release.cjs');
const { deferList, deferTickets, takes } = require('../src/bugs/defer.cjs');
const { isClosed } = require('../src/bugs/closing.cjs');
const { finishVersion } = require('../src/bugs/finish.cjs');
const { startE2e, settleRuns } = require('../src/e2e/step.cjs');
const { validRelease } = require('../src/release-commands.cjs');
const { setup, NOW, VERSION, OK } = require('./e2e-fixtures.cjs');

const low = key => ({ key, summary: `bug ${key}`, status: { name: 'To Do' }, priority: { name: 'Low' }, labels: [] });
const hit = (key, priority, labels = []) => ({ key, status: { name: 'To Do' }, priority: { name: priority }, labels });

async function world(t, options) {
  const s = await setup(t, options);
  s.ctx.bugs.baseContains = async () => ({ ok: false, detail: 'x' });
  s.check = now => checkRelease(s.ctx, s.project, s.version(), now, { force: true });
  return s;
}

const lowHits = (s, ...keys) => { s.hits.low = keys.map(low); };
const defer = (s, keys, by = 'PO Hà') => deferTickets(s.ctx, s.project, s.version(), { keys, by }, NOW);

test('R03: the PO defers open Medium/Low bugs, condition 4 honours it, and who and when are kept', async t => {
  const s = await world(t);
  lowHits(s, 'AAP1-4', 'AAP1-5');
  assert.equal((await assess(s.ctx, s.project, s.version(), NOW)).conditions[3].ok, false);
  assert.deepEqual(await defer(s, ['AAP1-4', 'AAP1-5']), { deferred: ['AAP1-4', 'AAP1-5'], already: [] });
  const four = (await assess(s.ctx, s.project, s.version(), NOW)).conditions[3];
  assert.equal(four.ok, true);
  assert.match(four.detail, /2 bug đã hoãn/);
  assert.deepEqual((await deferList(s.ctx, s.project, s.version(), NOW))[0], { key: 'AAP1-4', summary: 'bug AAP1-4', priority: 'Low', status: 'To Do', deferred: true, by: 'PO Hà', at: NOW });
  assert.deepEqual(s.actions('R03'), ['deferred', 'deferred']);
  assert.deepEqual(await defer(s, ['AAP1-4']), { deferred: [], already: ['AAP1-4'] });
});

test('R03: a High, closed or foreign ticket cannot be deferred, nor without a name, and nothing is written', async t => {
  const s = await world(t);
  lowHits(s, 'AAP1-4');
  await assert.rejects(defer(s, ['AAP1-4', 'AAP1-9']), /AAP1-9/);
  await assert.rejects(defer(s, ['AAP1-4'], ' '), /tên/);
  await assert.rejects(defer(s, ['AAP1-4'], 'a\nb'), /tên/);
  await assert.rejects(defer(s, []), /danh sách/);
  assert.equal(kv.get(s.db, `release-defer:AAP1:${VERSION}`), null);
});

test('R03: a deferred bug raised to Highest still blocks condition 2', async t => {
  const s = await world(t);
  lowHits(s, 'AAP1-4');
  await defer(s, ['AAP1-4']);
  s.hits.high = [low('AAP1-4')];
  assert.equal((await assess(s.ctx, s.project, s.version(), NOW)).conditions[1].ok, false);
});

test('R03: after closing the PO is asked about open Medium/Low once, the ask is not a condition 5 question, and it closes when deferred', async t => {
  const s = await world(t);
  lowHits(s, 'AAP1-4');
  await s.check(NOW);
  const again = await s.check(NOW + 1);
  assert.equal(s.waits('po').length, 1);
  assert.match(s.waits('po')[0], /AAP1-4.*R03/);
  assert.equal(again.conditions[4].ok, true);
  await defer(s, ['AAP1-4']);
  await s.check(NOW + 2);
  assert.deepEqual(s.waits('po'), []);
});

test('a version closes for features once condition 2 holds, a build was delivered and no feature is pending', async t => {
  const s = await world(t, { closed: false, build: false });
  await s.check(NOW);
  assert.equal(isClosed(s.db, 'AAP1', VERSION), false);
  await s.addBuild(1);
  s.ctx.bugs.featuresPending = () => true;
  await s.check(NOW + 1);
  assert.equal(isClosed(s.db, 'AAP1', VERSION), false);
  s.ctx.bugs.featuresPending = undefined;
  s.hits.high = [low('AAP1-1')];
  await s.check(NOW + 2);
  assert.equal(isClosed(s.db, 'AAP1', VERSION), false);
  s.hits.high = [];
  await s.check(NOW + 3);
  assert.equal(isClosed(s.db, 'AAP1', VERSION), true);
});

test('after closing only Highest/High, known tickets and claude-fix are taken; deferred ones never', async t => {
  const s = await world(t);
  const take = h => takes(s.ctx, s.project, s.version(), h);
  s.db.prepare("INSERT INTO tickets (project, key, version, priority, state, fingerprint, updated_at) VALUES ('AAP1', 'AAP1-3', ?, 2, 'done', 'x', 1)").run(VERSION);
  assert.deepEqual([take(hit('AAP1-1', 'High')), take(hit('AAP1-2', 'Medium')), take(hit('AAP1-3', 'Low')), take(hit('AAP1-4', 'Low', ['claude-fix']))], [true, false, true, true]);
  lowHits(s, 'AAP1-3');
  await defer(s, ['AAP1-3']);
  assert.equal(take(hit('AAP1-3', 'Low')), false);
  kv.del(s.db, `release-closed:AAP1:${VERSION}`);
  assert.equal(take(hit('AAP1-2', 'Medium')), true);
});

test('R04: three builds after closing without the conditions tells PO and dev once, and closes when they hold', async t => {
  const s = await world(t);
  s.hits.resolved = [low('AAP1-8')];
  await s.addBuild(2);
  await s.check(NOW);
  assert.deepEqual(s.actions('R04'), []);
  await s.addBuild(3);
  await s.check(NOW + 1);
  const again = await s.check(NOW + 2);
  assert.deepEqual(s.actions('R04'), ['release-stuck']);
  assert.match(s.waits('po')[0], /3 bản build.*3, 6.*R04/);
  assert.equal(s.waits('dev').filter(x => x.includes('R04')).length, 1);
  assert.equal(again.conditions[4].ok, true);
  s.hits.resolved = [];
  kv.set(s.db, `e2e:AAP1:${VERSION}`, { result: { tree: kv.get(s.db, `e2e-builds:AAP1:${VERSION}`)[0].tree, status: 'pass', failures: [], incomplete: [] } }, NOW);
  await s.check(NOW + 3);
  assert.deepEqual(s.waits('po'), []);
});

for (const [outcome, action] of [['done', 'released'], ['cancel', 'cancelled']]) {
  test(`R05: release ${outcome} turns polling off, closes the version and its waits, keeps others`, async t => {
    const s = await world(t);
    lowHits(s, 'AAP1-4');
    await s.check(NOW);
    s.device = null;
    await startE2e(s.ctx, s.project, s.version(), OK, NOW);
    openWait(s.db, { project: 'AAP1', role: 'qa', subject: `Kiểm bản cài AAP1 ${VERSION}` }, NOW);
    openWait(s.db, { project: 'AAP1', role: 'dev', subject: `Merge PR ${s.branch} (quá 400 dòng)` }, NOW);
    openWait(s.db, { project: 'AAP1', role: 'dev', subject: 'Merge PR dz/release-1.9.20 (quá 400 dòng)' }, NOW);
    assert.equal(finishVersion(s.ctx, s.project, s.version(), outcome, NOW).already, false);
    assert.deepEqual([s.version().state, s.version().polling], ['closed', false]);
    assert.deepEqual([...s.waits('po'), ...s.waits('qa'), ...s.waits('dev')], ['Merge PR dz/release-1.9.20 (quá 400 dòng)']);
    assert.deepEqual(s.actions('R05'), [action]);
    assert.equal(finishVersion(s.ctx, s.project, s.version(), outcome, NOW).already, true);
    assert.equal(await s.check(NOW + 5), null);
    assert.equal(s.waits('po').length, 0);
  });
}

test('R05: a version with an unfinished batch is refused untouched', async t => {
  const s = await world(t);
  s.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('AAP1', ?, 'normal', 'running', '[]', 1, 1)").run(VERSION);
  assert.throws(() => finishVersion(s.ctx, s.project, s.version(), 'done', NOW), /chưa xong/);
  assert.deepEqual([s.version().state, s.version().polling], ['open', true]);
});

test('R05: a queued E2E of a closed version is dropped and its device released without new waits', async t => {
  const s = await world(t);
  await startE2e(s.ctx, s.project, s.version(), OK, NOW);
  finishVersion(s.ctx, s.project, s.version(), 'cancel', NOW);
  assert.deepEqual(await settleRuns(s.ctx, s.project, NOW), [VERSION]);
  assert.equal(s.locks.at(-1)[0], 'release');
  assert.deepEqual([...s.waits('dev'), ...s.waits('qa')], []);
});

test('R02: a Highest bug after the release notice withdraws it even with E2E passed', async t => {
  const s = await world(t);
  await startE2e(s.ctx, s.project, s.version(), OK, NOW);
  s.finish();
  await settleRuns(s.ctx, s.project, NOW);
  s.ctx.bugs.baseContains = async () => ({ ok: true, detail: 'x' });
  assert.equal((await s.check(NOW + 1)).ready, 'release');
  s.hits.high = [low('AAP1-9')];
  assert.equal((await s.check(NOW + 2)).ready, 'none');
  assert.deepEqual(s.actions('R02'), ['revoke-release']);
  assert.equal(kv.get(s.db, releaseKey('AAP1', VERSION)).ready, 'none');
});

test('dz release arguments are checked', () => {
  const ok = text => validRelease(text.split(' '));
  for (const text of ['status AAP1 1.9.2', 'defer AAP1 1.9.2 AAP1-4 AAP1-5 --by Hà', 'e2e AAP1 1.9.2 accept --by Lan', 'done AAP1 1.9.2', 'cancel AAP1 1.9.2']) assert.equal(ok(text), true, text);
  for (const text of ['done AAP1', 'done AAP1 1.9.2 x', 'defer AAP1 1.9.2 AAP1-4', 'defer AAP1 1.9.2 --by Hà', 'defer AAP1 1.9.2 BBB1-4 --by Hà', 'e2e AAP1 1.9.2 maybe --by Lan', 'e2e AAP1 1.9.2 accept', 'drop AAP1 1.9.2']) assert.equal(ok(text), false, text);
  assert.equal(validRelease([]), false);
  assert.equal(store.VERSION_RE.test('1.9.2'), true);
});
