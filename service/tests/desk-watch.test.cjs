const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const kv = require('../src/kv.cjs');
const inbox = require('../src/inbox.cjs');
const { setWanted } = require('../src/desk.cjs');
const { deskPaths } = require('../src/desk-config.cjs');
const { NOW, MIN, CHANNEL, THREAD, idAt, project, message } = require('./desk-fixtures.cjs');
const { setupWatch } = require('./desk-watch-fixtures.cjs');

test('off: nothing is opened; a running session is closed', async t => {
  const h = setupWatch(t, { wanted: false });
  assert.equal(await h.step(NOW), 'off');
  assert.deepEqual(h.names(), []);
  h.state.row = { pid: 5, startedAt: NOW, alive: true };
  await h.step(NOW);
  assert.deepEqual(h.names(), ['stop']);
});

test('no project with a channel: nothing is opened', async t => {
  const h = setupWatch(t);
  assert.equal(await h.manager.step([project('AAA', { channel: undefined }), project('BBB', { enabled: false })], NOW), 'off');
  assert.deepEqual(h.names(), []);
});

test('first start reads the missed messages before opening the session', async t => {
  const h = setupWatch(t);
  h.state.missed = message(idAt(NOW - MIN));
  assert.equal(await h.step(NOW), 'started');
  assert.deepEqual(h.names(), ['read', 'start']);
  assert.equal(inbox.pending(h.db).length, 1);
  assert.equal(h.manager.status(NOW).restarts, 0);
});

test('a healthy session is left alone and the channel is read once a minute', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  h.events.length = 0;
  for (const at of [10, 20, 30, 40, 50, 60, 75]) assert.equal(await h.step(NOW + at * 1000), 'alive');
  assert.deepEqual(h.names(), ['read', 'read']);
  assert.deepEqual(JSON.parse(fs.readFileSync(deskPaths(h.home).replyChannels, 'utf8')), { channels: [CHANNEL, THREAD], keys: { [CHANNEL]: ['AAA'], [THREAD]: ['AAA'] } });
});

test('a dead session is restarted', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  h.state.row.alive = false;
  assert.equal(await h.step(NOW + MIN), 'restarted');
  assert.deepEqual(h.names(), ['read', 'start', 'stop', 'read', 'start']);
});

test('a message unacked for two minutes restarts the session and stays pending', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  h.unacked(NOW + MIN);
  assert.equal(await h.step(NOW + 2 * MIN + 59000), 'alive');
  assert.equal(await h.step(NOW + 3 * MIN), 'restarted');
  assert.equal(inbox.pending(h.db).length, 1);
});

test('a new session gets two minutes before old pending rows count', async t => {
  const h = setupWatch(t);
  h.unacked(NOW - 10 * MIN);
  await h.step(NOW);
  assert.equal(await h.step(NOW + MIN), 'alive');
  assert.equal(await h.step(NOW + 2 * MIN), 'restarted');
  assert.equal(await h.step(NOW + 3 * MIN), 'alive');
});

test('a session working through a backlog is not restarted', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  const rows = [h.unacked(NOW), h.unacked(NOW)];
  inbox.ack(h.db, rows[0].messageId, CHANNEL, NOW + 2 * MIN);
  assert.equal(await h.step(NOW + 3 * MIN), 'alive');
  assert.equal(await h.step(NOW + 4 * MIN), 'restarted');
});

test('daily restart after 4 am only when idle and nothing is pending', async t => {
  const h = setupWatch(t);
  const evening = Date.parse('2026-11-25T20:00:00+07:00');
  const at = text => Date.parse(`2026-11-26T${text}:00+07:00`);
  await h.step(evening);
  assert.equal(await h.step(at('03:59')), 'alive');
  const row = h.unacked(at('03:59'));
  assert.equal(await h.step(at('04:00')), 'alive');
  inbox.ack(h.db, row.messageId, CHANNEL, at('04:00'));
  assert.equal(await h.step(at('04:05')), 'alive');
  assert.equal(await h.step(at('04:10')), 'daily');
  assert.equal(await h.step(at('04:30')), 'alive');
  assert.equal(h.manager.status(at('04:30')).restarts, 0);
});

test('daily restart is skipped when the last read finds a message', async t => {
  const h = setupWatch(t);
  await h.step(Date.parse('2026-11-25T20:00:00+07:00'));
  const now = Date.parse('2026-11-26T05:00:00+07:00');
  await h.step(now - MIN * 70);
  h.state.missed = message(idAt(now));
  assert.equal(await h.step(now), 'alive');
  assert.equal(h.names().filter(name => name === 'stop').length, 0);
});

test('turned off while opening: the new session is closed', async t => {
  const h = setupWatch(t);
  h.state.onStart = () => setWanted(h.db, false, NOW);
  await h.step(NOW);
  assert.deepEqual(h.names(), ['read', 'start', 'stop']);
});

test('steps never overlap and errors do not escape', async t => {
  const h = setupWatch(t);
  const [first, second] = [h.step(NOW), h.step(NOW)];
  assert.equal(first, second);
  await first;
  h.state.failStart = true;
  h.state.row.alive = false;
  assert.equal(await h.step(NOW + MIN), 'error');
  assert.ok(h.events.some(item => item.event === 'desk-error'));
});

test('stop turns the desk off and status shows it', async t => {
  const h = setupWatch(t);
  await h.step(NOW);
  assert.equal(h.manager.status(NOW).alive, true);
  assert.equal(await h.manager.stop(NOW), true);
  const { wanted, alive, pid } = h.manager.status(NOW);
  assert.deepEqual({ wanted, alive, pid }, { wanted: false, alive: false, pid: null });
  assert.equal(kv.get(h.db, 'desk:wanted'), false);
});
