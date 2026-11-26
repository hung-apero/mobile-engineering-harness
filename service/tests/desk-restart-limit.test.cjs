const test = require('node:test');
const assert = require('node:assert/strict');
const inbox = require('../src/inbox.cjs');
const { resolveWait } = require('../src/pings.cjs');
const { setWanted } = require('../src/desk.cjs');
const { NOW, MIN, CHANNEL } = require('./desk-fixtures.cjs');
const { setupWatch, burn } = require('./desk-watch-fixtures.cjs');

const HOUR = 60 * MIN;

test('restarts back off: 30 s, 1 min, 2 min, 4 min', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  let now = NOW + MIN;
  h.state.row.alive = false;
  assert.equal(await h.step(now), 'restarted');
  for (const wait of [30, 60, 120, 240]) {
    h.state.row.alive = false;
    assert.equal(await h.step(now + wait * 1000 - 1), 'backoff');
    now += wait * 1000;
    assert.equal(await h.step(now), 'restarted');
  }
});

test('five restarts in an hour open one dev wait and stop restarting', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  const now = await burn(h, NOW + MIN);
  h.state.row.alive = false;
  assert.equal(await h.step(now), 'held');
  assert.equal(await h.step(now + 2 * HOUR), 'held');
  assert.deepEqual(h.waits().map(wait => [wait.project, wait.role]), [['AAA', 'dev']]);
  assert.equal(h.names().filter(name => name === 'start').length, 6);
});

test('restarts spread over more than an hour do not hold', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  for (let i = 0; i < 8; i += 1) {
    h.state.row.alive = false;
    assert.equal(await h.step(NOW + i * 13 * MIN + MIN), 'restarted');
  }
  assert.deepEqual(h.waits(), []);
});

test('dev closing the wait or turning the desk on again lets it restart', async t => {
  for (const release of [(h, now) => resolveWait(h.db, h.waits()[0].id, now), (h, now) => setWanted(h.db, true, now)]) {
    const h = setupWatch(t);
    await h.step(NOW);
    const now = await burn(h, NOW + MIN);
    h.state.row.alive = false;
    await h.step(now);
    release(h, now);
    assert.notEqual(await h.step(now + 1), 'held');
    assert.equal(h.state.row.alive, true);
    assert.deepEqual(h.waits(), []);
  }
});

test('a stuck session that recovers closes the dev wait by itself', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  const now = await burn(h, NOW + MIN);
  const row = h.unacked(now);
  assert.equal(await h.step(now + 3 * MIN), 'held');
  assert.equal(h.waits().length, 1);
  inbox.ack(h.db, row.messageId, CHANNEL, now + 4 * MIN);
  assert.equal(await h.step(now + 5 * MIN), 'alive');
  assert.deepEqual(h.waits(), []);
});

test('a start that keeps failing is counted and ends in a dev wait', async t => {
  const h = setupWatch(t);
  h.state.failStart = true;
  const results = [];
  for (let i = 0; i < 8; i += 1) results.push(await h.step(NOW + i * 9 * MIN));
  assert.equal(results.filter(result => result === 'error').length, 5);
  assert.ok(results.includes('held'));
});
