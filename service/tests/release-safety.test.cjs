const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const jobs = require('../src/jobs.cjs');
const store = require('../src/bugs/store.cjs');
const { ensureMirror } = require('../src/bugs/workspace.cjs');
const { assess, checkRelease, baseContains } = require('../src/bugs/release.cjs');
const { takes, deferTickets } = require('../src/bugs/defer.cjs');
const { finishVersion } = require('../src/bugs/finish.cjs');
const { planBatches } = require('../src/bugs/intake.cjs');
const { resetDry } = require('../src/bugs/reset-dry.cjs');
const { startE2e, settleRuns } = require('../src/e2e/step.cjs');
const { dryWaitIds } = require('../src/bugs/dry-traces.cjs');
const { merged, buildJob } = require('./release-merged-fixtures.cjs');
const { setup, NOW, VERSION, OK } = require('./e2e-fixtures.cjs');

const HOUR = 3600000;
const start = (s, now = NOW) => startE2e(s.ctx, s.project, s.version(), OK, now);

test('F1: a merge whose tree is not the tested tree takes condition 6 back, builds that tree and needs a new E2E', async t => {
  const s = await merged(t);
  await start(s);
  s.finish();
  await settleRuns(s.ctx, s.project, NOW);
  assert.equal((await s.assess()).ready, 'merge');
  s.baseWork({ 'other.txt': 'x\n' });
  const mergeSha = await s.mergeVersion('--no-ff');
  const after = await s.assess();
  assert.deepEqual([after.conditions[0].ok, after.conditions[5].ok, after.ready], [true, null, 'none']);
  assert.equal(await start(s, NOW + 1), false);
  assert.equal(buildJob(s).payload.sha, mergeSha);
  assert.equal(buildJob(s).payload.distribute, false);
  assert.equal(await start(s, NOW + 2), false);
  assert.equal(jobs.listJobs(s.db, { project: 'AAP1' }).filter(job => job.kind === 'build').length, 1);
  s.finishBuild(true);
  assert.deepEqual(await settleRuns(s.ctx, s.project, NOW + 3), [VERSION]);
  assert.equal(await start(s, NOW + 4), true);
  assert.equal(s.job().payload.sha, mergeSha);
  s.finish();
  await settleRuns(s.ctx, s.project, NOW + 5);
  assert.equal((await s.assess()).ready, 'release');
});

test('F1: a merge with the same tree keeps condition 6, and later work on base does not take it back', async t => {
  for (const flags of [['--no-ff'], ['--ff-only']]) {
    const s = await merged(t);
    await start(s);
    s.finish();
    await settleRuns(s.ctx, s.project, NOW);
    await s.mergeVersion(...flags);
    s.baseWork({ 'later.txt': 'x\n' });
    await ensureMirror({ dzHome: s.dzHome, project: s.project, githubUrl: s.github });
    assert.equal((await s.assess()).ready, 'release', flags[0]);
  }
});

test('F1: a failing build of the merged tree wakes the dev and is tried again after an hour, at most twice', async t => {
  const s = await merged(t);
  s.baseWork({ 'other.txt': 'x\n' });
  await s.mergeVersion('--no-ff');
  for (const at of [NOW, NOW + HOUR]) {
    assert.equal(await start(s, at), false);
    s.finishBuild(false);
    await settleRuns(s.ctx, s.project, at);
    await start(s, at + 1);
  }
  await start(s, NOW + 5 * HOUR);
  assert.equal(jobs.listJobs(s.db, { project: 'AAP1' }).filter(job => job.kind === 'build').length, 2);
  assert.match(s.waits('dev').join(), /build/i);
});

test('F11: a deferred bug raised to Highest is taken again', async t => {
  const s = await setup(t);
  const low = { key: 'AAP1-4', summary: 'x', status: { name: 'To Do' }, priority: { name: 'Low' }, labels: [] };
  s.hits.low = [low];
  await deferTickets(s.ctx, s.project, s.version(), { keys: ['AAP1-4'], by: 'Hà' }, NOW);
  assert.equal(takes(s.ctx, s.project, s.version(), low), false);
  assert.equal(takes(s.ctx, s.project, s.version(), { ...low, priority: { name: 'Highest' } }), true);
});

test('F12: closing a version frees its accepted tickets for the next version and never batches them', async t => {
  const s = await setup(t);
  const put = (key, state) => s.db.prepare("INSERT INTO tickets (project, key, version, priority, state, fingerprint, updated_at) VALUES ('AAP1', ?, ?, 1, ?, 'x', 1)").run(key, VERSION, state);
  put('AAP1-1', 'accepted');
  put('AAP1-2', 'done');
  finishVersion(s.ctx, s.project, s.version(), 'done', NOW);
  assert.deepEqual(['AAP1-1', 'AAP1-2'].map(key => store.getTicket(s.db, 'AAP1', key).state), ['skipped', 'done']);
  kv.del(s.db, `bug-off:AAP1:${VERSION}`);
  s.db.prepare("UPDATE tickets SET state = 'accepted' WHERE key = 'AAP1-1'").run();
  assert.deepEqual(planBatches(s.db, 'AAP1', NOW + 100 * HOUR), []);
});

test('F12: a batch created while the version is being closed stops the closing', async t => {
  const s = await setup(t);
  const exec = s.db.exec.bind(s.db);
  let raced = false;
  s.db.exec = sql => {
    if (sql.startsWith('BEGIN') && !raced) {
      raced = true;
      s.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('AAP1', ?, 'normal', 'open', '[]', 1, 1)").run(VERSION);
    }
    return exec(sql);
  };
  assert.throws(() => finishVersion(s.ctx, s.project, s.version(), 'done', NOW), /chưa xong/);
  assert.deepEqual([s.version().state, s.version().polling], ['open', true]);
});

test('F13: reset-dry clears closing, deferral, builds, E2E and release state with their waits', async t => {
  const s = await setup(t, { device: null });
  s.ctx.bugs.baseContains = async () => ({ ok: false, detail: 'x' });
  s.hits.low = [{ key: 'AAP1-4', status: { name: 'To Do' }, priority: { name: 'Low' }, labels: [] }, { key: 'AAP1-5', status: { name: 'To Do' }, priority: { name: 'Low' }, labels: [] }];
  await deferTickets(s.ctx, s.project, s.version(), { keys: ['AAP1-4'], by: 'Hà' }, NOW);
  await checkRelease(s.ctx, s.project, s.version(), NOW, { force: true });
  await start(s);
  const waits = s.db.prepare("SELECT id FROM waits WHERE state = 'open'").all().map(w => w.id);
  assert.ok(waits.length >= 2);
  assert.ok(waits.every(id => dryWaitIds(s.db, 'AAP1').has(id)), 'dry waits are tracked');
  await resetDry(s.ctx, s.project, VERSION);
  for (const key of ['release-closed', 'release-defer', 'e2e-builds', 'bug-release']) assert.equal(kv.get(s.db, `${key}:AAP1:${VERSION}`), null, key);
  assert.equal(kv.get(s.db, `e2e:AAP1:${VERSION}`)?.result ?? null, null);
  assert.deepEqual(s.db.prepare("SELECT subject FROM waits WHERE state = 'open'").all(), []);
});

test('F13: a release wait opened dry is opened again as a live wait, so that it pings', async t => {
  const s = await setup(t);
  s.ctx.bugs.baseContains = async () => ({ ok: false, detail: 'x' });
  s.hits.low = [{ key: 'AAP1-4', status: { name: 'To Do' }, priority: { name: 'Low' }, labels: [] }];
  const check = at => checkRelease(s.ctx, s.project, s.version(), at, { force: true });
  await check(NOW);
  s.project.live = true;
  await check(NOW + 1);
  const open = s.db.prepare("SELECT id, opened_at FROM waits WHERE state = 'open' AND role = 'po'").all();
  assert.deepEqual(open.map(w => [w.opened_at, dryWaitIds(s.db, 'AAP1').has(w.id)]), [[NOW + 1, false]]);
});

test('F13: reset-dry refuses while a dry E2E still runs', async t => {
  const s = await setup(t);
  await start(s);
  await assert.rejects(resetDry(s.ctx, s.project, VERSION), /E2E/);
  assert.notEqual(kv.get(s.db, `release-closed:AAP1:${VERSION}`), null);
});

test('baseContains still answers without a version branch', async t => {
  const s = await setup(t, { build: false });
  assert.equal((await baseContains({ dzHome: s.dzHome, bugs: { git: s.ctx.bugs.git, githubUrl: s.github } }, s.project, { version: '9.9', branch: 'dz/release-9.9' })).ok, false);
});
