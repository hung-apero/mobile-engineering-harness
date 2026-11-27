const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/bugs/store.cjs');
const commands = require('../src/commands.cjs');
const bugCommands = require('../src/bug-commands.cjs');
const { makeHome, NOW } = require('./service-fixtures.cjs');

test('C2: dz bugs reset-dry calls resetDry(ctx, project, version) and reports', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const calls = [];
  ctx.bugs = { resetDry: async (...args) => { calls.push(args); return { tickets: 2 }; } };
  const lines = await bugCommands.bugs(ctx, ['reset-dry', 'ABC1', '1.9.2'], NOW);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], ctx);
  assert.equal(calls[0][1].key, 'ABC1');
  assert.equal(calls[0][2], '1.9.2');
  assert.match(lines.join('\n'), /reset-dry|chạy khô/);
});

test('C2: reset-dry arguments are validated and an unknown project fails', async t => {
  const h = makeHome(t);
  assert.equal(bugCommands.validBugs(['reset-dry', 'ABC1', '1.9.2']), true);
  for (const bad of [['reset-dry'], ['reset-dry', 'ABC1'], ['reset-dry', 'abc', '1.9.2'], ['reset-dry', 'ABC1', 'x y'], ['reset-dry', 'ABC1', '1.9.2', 'x']]) assert.equal(bugCommands.validBugs(bad), false, bad.join(' '));
  const ctx = h.context();
  ctx.bugs = { resetDry: async () => ({}) };
  await assert.rejects(bugCommands.bugs(ctx, ['reset-dry', 'NOPE9', '1.9.2'], NOW), /NOPE9/);
  assert.equal(h.dz('bugs', 'reset-dry', 'ABC1').status, 2);
});

test('I7: dz batch park calls requestPark(db, batchId, now) for an unfinished batch only', t => {
  const h = makeHome(t);
  const ctx = h.context();
  store.ensureVersion(ctx.db, { project: 'ABC1', version: '1.9.2' });
  ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'done', '[]', 1, 1)").run();
  const calls = [];
  ctx.bugs = { requestPark: (...args) => calls.push(args) };
  const lines = bugCommands.batch(ctx, ['park', '1'], NOW);
  assert.deepEqual(calls, [[ctx.db, 1, NOW]]);
  assert.match(lines.join('\n'), /#1/);
  assert.throws(() => bugCommands.batch(ctx, ['park', '2'], NOW), /#2/);
  assert.throws(() => bugCommands.batch(ctx, ['park', '9'], NOW), /#9/);
  assert.equal(calls.length, 1);
});

test('I7: batch park arguments are validated', () => {
  assert.equal(bugCommands.validBatch(['park', '3']), true);
  assert.equal(bugCommands.validBatch(['3']), true);
  for (const bad of [['park'], ['park', 'x'], ['park', '0'], ['zap', '1'], ['park', '1', '2']]) assert.equal(bugCommands.validBatch(bad), false, bad.join(' '));
});

test('dz resume clears build_failures of the project versions', t => {
  const h = makeHome(t);
  const ctx = h.context();
  store.ensureVersion(ctx.db, { project: 'ABC1', version: '1.9.2' });
  ctx.db.prepare('UPDATE versions SET build_failures = 4').run();
  commands.resume(ctx, 'ABC1', NOW);
  assert.equal(store.getVersion(ctx.db, 'ABC1', '1.9.2').buildFailures, 0);
});
