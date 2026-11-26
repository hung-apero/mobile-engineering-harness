const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../vendor/learn-app/lib/learn-app-state.cjs');
const { setupBuild, editState, put, PLAN } = require('./specs-build-fixtures.cjs');

const IDS = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, '0')}-p`);
const write = (repo, plans) => {
  put(repo, Object.fromEntries(IDS.map(id => [`plans/${id}.md`, PLAN(id)])));
  editState(repo, state => {
    state.step = 'coding';
    state.plans = plans;
  });
};
const launches = s => s.ctx.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'spec' AND key LIKE '%#build-%'").get().n;

async function dieUntilParked(s, plansAt) {
  for (let i = 0; i < 12 && s.spec().state === 'building'; i++) await s.finish(repo => write(repo, plansAt(i)));
  assert.equal(s.spec().state, 'parked');
  return launches(s);
}

test('a worker that dies with the plan statuses going back and forth is parked, not launched forever (I8)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const n = await dieUntilParked(s, i => ({ [IDS[0]]: { status: ['coding', 'coded', 'reviewed'][i % 3], files: [] } }));
  assert.ok(n <= 3, `${n} lần`);
  assert.equal(s.waits().filter(wait => wait.role === 'dev').length, 1);
});

test('a merged plan that is opened and merged again is not progress (I8)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const n = await dieUntilParked(s, i => ({ [IDS[0]]: { status: i % 2 ? 'todo' : 'merged', files: [] } }));
  assert.ok(n <= 3, `${n} lần`);
});

test('even with a plan merged each time a build launches 8 times at most, and retry starts a new count (I8)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  const merged = count => Object.fromEntries(IDS.slice(0, count).map(id => [id, { status: 'merged', files: ['x'] }]));
  assert.equal(await dieUntilParked(s, i => merged(i + 1)), 8);
  assert.match(s.spec().data.parked.reason, /8 lần/);
  await s.cmd('retry', String(s.id));
  await s.finish(repo => write(repo, merged(9)));
  assert.equal(s.spec().state, 'building');
  assert.equal(S.readState(s.repo()).step, 'coding');
});
