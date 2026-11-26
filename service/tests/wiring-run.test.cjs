const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const { runService } = require('../src/run.cjs');
const { socketPath } = require('../src/mcp/socket.cjs');
const { makeHome, NOW } = require('./service-fixtures.cjs');

function fakeDesk(calls) {
  return { step: (projects, now) => { calls.push({ keys: [...projects].map(p => p.key), now }); return Promise.resolve('alive'); } };
}

test('context builds the desk manager, the bot and the shared facade without reading the token', t => {
  const ctx = makeHome(t).context();
  assert.equal(typeof ctx.desk.step, 'function');
  assert.equal(typeof ctx.deskBot.messagesAfter, 'function');
  assert.equal(typeof ctx.facade.openSpecs, 'function');
});

test('every tick gives the desk the loaded projects, without waiting for it', async t => {
  const h = makeHome(t, ['ABC1', 'ABC2']);
  const ctx = h.context();
  const calls = [];
  ctx.desk = { step: (projects, now) => { calls.push({ keys: [...projects].map(p => p.key).sort(), now }); return new Promise(() => {}); } };
  await tick(ctx, NOW);
  assert.deepEqual(calls, [{ keys: ['ABC1', 'ABC2'], now: NOW }]);
});

test('the desk is not stepped when the projects directory cannot be read', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const calls = [];
  ctx.desk = fakeDesk(calls);
  fs.rmSync(ctx.projectsDir, { recursive: true });
  await tick(ctx, NOW);
  assert.deepEqual(calls, []);
});

test('a desk step that fails never fails the tick', async t => {
  const ctx = makeHome(t).context();
  ctx.desk = { step: () => Promise.reject(new Error('boom')) };
  await tick(ctx, NOW);
  await tick(ctx, NOW + 10000);
});

test('service run opens the dz socket before the first tick and removes it on stop', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const signals = new Map();
  const file = socketPath(ctx.dzHome);
  let seen = null;
  const tickFn = async () => {
    seen = fs.lstatSync(file, { throwIfNoEntry: false })?.isSocket() === true;
    await new Promise((resolve, reject) => {
      const client = net.connect(file);
      client.once('connect', () => client.write(`${JSON.stringify({ id: 1, tool: 'pending', args: {} })}\n`));
      client.once('data', data => {
        seen = [seen, JSON.parse(String(data).trim()).ok];
        client.destroy();
        resolve();
      });
      client.once('error', reject);
    });
    signals.get('SIGTERM')();
  };
  assert.equal(await runService(ctx, { tickMs: 5, stopWaitMs: 100, tickFn, on: (name, fn) => signals.set(name, fn) }), 0);
  assert.deepEqual(seen, [true, true]);
  assert.equal(fs.existsSync(file), false);
});

test('a dz socket that cannot start is logged and the service still runs', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  fs.writeFileSync(socketPath(ctx.dzHome), 'not a socket');
  const signals = new Map();
  const tickFn = async () => signals.get('SIGTERM')();
  assert.equal(await runService(ctx, { tickMs: 5, stopWaitMs: 100, tickFn, on: (name, fn) => signals.set(name, fn) }), 0);
  assert.equal(h.logs('desk-socket-failed').length, 1);
  assert.equal(fs.readFileSync(socketPath(ctx.dzHome), 'utf8'), 'not a socket');
});

test('shutdown waits for a running desk step', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  let release;
  let settled = false;
  ctx.deskStepPending = new Promise(resolve => { release = resolve; }).then(() => { settled = true; });
  const signals = new Map();
  const tickFn = async () => {
    signals.get('SIGTERM')();
    setTimeout(release, 30);
  };
  await runService(ctx, { tickMs: 5, stopWaitMs: 100, bugWaitMs: 2000, tickFn, on: (name, fn) => signals.set(name, fn) });
  assert.equal(settled, true);
});

test('a dry project with a channel stays fully silent outside: no request leaves the process and nothing is posted', async t => {
  const h = makeHome(t);
  h.project('ABC1', { channel: '900000000000000002', roles: {}, live: false });
  const ctx = h.context();
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args[0]);
    throw new Error('no network');
  };
  t.after(() => { globalThis.fetch = original; });
  await tick(ctx, NOW);
  await tick(ctx, NOW + 10000);
  await ctx.deskStepPending;
  assert.deepEqual(calls, []);
  assert.equal(h.logs('would').length, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 0);
});
