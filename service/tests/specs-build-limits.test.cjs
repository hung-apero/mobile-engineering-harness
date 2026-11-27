const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupBuild, put } = require('./specs-build-fixtures.cjs');

const IDS = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0')}-p`);
const write = (repo, statuses) => put(repo, { 'progress.json': { plans: IDS.map((id, i) => ({ id, status: statuses[i] ?? 'todo' })) } });
const launches = s => s.ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'spec' AND key LIKE '%#build-%'").get().n;

async function dieUntilParked(s, statusesAt) {
  for (let i = 0; i < 12 && s.spec().state === 'building'; i++) await s.finish(repo => write(repo, statusesAt(i)));
  assert.equal(s.spec().state, 'parked');
  return launches(s);
}

test('a worker that dies with the plan statuses going back and forth is parked, not launched forever (I8)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const n = await dieUntilParked(s, i => [['coding', 'coded', 'reviewed'][i % 3]]);
  assert.ok(n <= 3, `${n} lần`);
  assert.equal(s.waits().filter(wait => wait.role === 'dev').length, 1);
});

test('a done plan that is opened and done again is not progress (I8)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const n = await dieUntilParked(s, i => [i % 2 ? 'todo' : 'done']);
  assert.ok(n <= 3, `${n} lần`);
});

test('even with a plan done each time a build launches 8 times at most, and retry starts a new count (I8)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const done = count => IDS.slice(0, count).map(() => 'done');
  assert.equal(await dieUntilParked(s, i => done(i + 1)), 8);
  assert.match(s.spec().data.parked.reason, /8 lần/);
  await s.cmd('retry', String(s.id));
  assert.equal(s.spec().data.build.launches, 0);
  await s.finish(repo => write(repo, done(9)));
  assert.equal(s.spec().state, 'building');
  assert.equal(s.spec().data.build.launches, 2);
  await s.until(() => s.running('spec').length === 1, 'build lại');
});
