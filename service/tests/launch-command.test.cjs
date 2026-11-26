const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const kv = require('../src/kv.cjs');
const { startBlock } = require('../src/intake-state.cjs');
const { makeHome, add, fakeWorkers, waitFor, NOW } = require('./service-fixtures.cjs');

const RUN_STEP = path.join(__dirname, '..', 'src', 'run-step.cjs');
const node = (...args) => ({ bin: process.execPath, args });
const gate = (ctx, command, extra = {}) => { ctx.handlers.gate = { prepare: () => ({ command, cwd: ctx.dzHome, ...extra }) }; };
const addGate = (ctx, key = 'g') => add(ctx, 'ABC1', key, { kind: 'gate' });
const job = (ctx, id) => jobs.getJob(ctx.db, id);

test('a command job starts bin and args with its session id, without claude, with the worker env and overrides', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  gate(ctx, { bin: '/bin/tool', args: ['a b', 'spec.json'] }, { env: { GH_CONFIG_DIR: '/empty', GH_TOKEN: 'x', JAVA_HOME: null } });
  const id = addGate(ctx);
  ctx.env = { ...ctx.env, JAVA_HOME: '/j', DISCORD_TOKEN: 'x' };
  await tick(ctx, NOW);
  assert.equal(calls[0].bin, '/bin/tool');
  assert.deepEqual(calls[0].args, ['a b', 'spec.json', '--session-id', job(ctx, id).sessionId]);
  assert.equal(calls[0].cwd, h.dzHome);
  const { env } = calls[0];
  assert.deepEqual([env.GH_CONFIG_DIR, env.LEARN_APP_BUILD_SLOTS, env.GH_TOKEN, env.JAVA_HOME, env.DISCORD_TOKEN], ['/empty', '1', undefined, undefined, undefined]);
});

test('a resumed command job runs the same command from the start', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls, alive } = fakeWorkers(ctx);
  gate(ctx, { bin: '/bin/tool', args: ['spec.json'] });
  const id = addGate(ctx);
  await tick(ctx, NOW);
  fs.appendFileSync(ctx.deps.logFileFor(job(ctx, id)), `${JSON.stringify({ type: 'assistant' })}\n`);
  alive.clear();
  await tick(ctx, NOW + 10000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['spec.json', '--session-id', job(ctx, id).sessionId]);
  assert.notEqual(calls[1].logFile, calls[0].logFile);
});

test('a real command job forgotten between spawn and markRunning is adopted and finished', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const spec = path.join(h.root, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ steps: [{ name: 'ngủ', argv: [process.execPath, '-e', 'setTimeout(() => {}, 2500)'], cwd: h.root, timeoutMs: 20000 }] }));
  gate(ctx, node(RUN_STEP, spec));
  const id = addGate(ctx);
  ctx.db.exec("CREATE TRIGGER no_run BEFORE UPDATE OF state ON jobs WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'đĩa đầy'); END");
  await tick(ctx, NOW);
  assert.equal(job(ctx, id).state, 'starting');
  ctx.db.exec('DROP TRIGGER no_run');
  await tick(ctx, NOW + 10000);
  assert.equal(job(ctx, id).state, 'running');
  const { pid, pidStart } = job(ctx, id);
  await waitFor(() => !ctx.deps.isSameProcess(pid, pidStart), 15000);
  await tick(ctx, NOW + 20000);
  assert.equal(job(ctx, id).state, 'done');
  assert.equal(job(ctx, id).attempt, 1);
  assert.equal(JSON.parse(job(ctx, id).result.text).steps[0].ok, true);
});

test('a real command job whose step fails ends failed once with the result of every step', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const spec = path.join(h.root, 'spec.json');
  const step = (name, code) => ({ name, argv: [process.execPath, '-e', `process.exit(${code})`], cwd: h.root, timeoutMs: 20000 });
  fs.writeFileSync(spec, JSON.stringify({ steps: [step('compile', 0), step('test', 3), step('lint', 0)] }));
  gate(ctx, node(RUN_STEP, spec));
  const id = addGate(ctx);
  await tick(ctx, NOW);
  const { pid, pidStart } = job(ctx, id);
  await waitFor(() => !ctx.deps.isSameProcess(pid, pidStart), 15000);
  await tick(ctx, NOW + 10000);
  const done = job(ctx, id);
  assert.deepEqual([done.state, done.resumes, done.attempt, done.result.error], ['failed', 0, 1, 'step_failed']);
  assert.deepEqual(JSON.parse(done.result.text).steps.map(s => [s.name, s.ok, s.exitCode]), [['compile', true, 0], ['test', false, 3]]);
});

test('a missing command binary or node script parks only that job and is not claude-missing', async t => {
  const gone = h => path.join(h.root, 'gone');
  for (const command of [h => ({ bin: gone(h), args: [] }), h => node(gone(h), 'spec.json')]) {
    const h = makeHome(t);
    const ctx = h.context();
    gate(ctx, command(h));
    const id = addGate(ctx);
    const probe = add(ctx, 'ABC1', 'p');
    await tick(ctx, NOW);
    assert.equal(job(ctx, id).state, 'parked');
    assert.match(job(ctx, id).parkReason, /gone/);
    assert.equal(startBlock(ctx.db, NOW), null);
    assert.deepEqual(h.logs('claude-missing'), []);
    assert.deepEqual(kv.keys(ctx.db, 'start-failures:'), []);
    assert.equal(job(ctx, probe).state, 'running');
  }
});

test('a started command job does not clear a claude-missing block', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx, o => (o.bin === '/bin/tool' ? null : Object.assign(new Error('ENOENT'), { machineWide: true })));
  gate(ctx, { bin: '/bin/tool', args: [] });
  add(ctx, 'ABC1', 'p', { priority: 2 });
  await tick(ctx, NOW);
  addGate(ctx);
  await tick(ctx, NOW + 5 * 60000);
  await tick(ctx, NOW + 5 * 60000 + 10000);
  assert.equal(calls.filter(c => c.bin === '/bin/tool').length, 1);
  assert.equal(h.logs('claude-missing').length, 1);
});

test('a command for an agent kind, a prompt for a command kind and arguments that hide the session id park the job', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  const cases = [
    ['bug', { command: { bin: '/bin/tool', args: [] } }],
    ['gate', { prompt: 'p' }],
    ['gate', { command: { bin: '/bin/tool', args: ['--', 'x'] } }],
    ['gate', { command: { bin: '/bin/tool', args: ['/a -- b/spec.json'] } }],
    ['gate', { command: { bin: '/bin/tool', args: ['--session-id', 'x'] } }],
    ['gate', { command: { bin: '/bin/tool', args: ['--resume', 'x'] } }],
    ['gate', { command: { bin: '/bin/tool' } }],
  ];
  for (const [index, [kind, prepared]] of cases.entries()) {
    ctx.handlers[kind] = { prepare: () => ({ cwd: h.root, ...prepared }) };
    const id = add(ctx, 'ABC1', `k${index}`, { kind });
    await tick(ctx, NOW + index * 10000);
    assert.equal(job(ctx, id).state, 'parked', String(index));
  }
  assert.equal(calls.length, 0);
});

test('an agent job gets env overrides, json schema, permission mode and its own resume prompt', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls, alive } = fakeWorkers(ctx);
  const seen = [];
  ctx.handlerDeps = { git: 'fake' };
  ctx.handlers.review = {
    prepare: (_, options) => {
      seen.push(options);
      return { prompt: 'p', resumePrompt: 'Làm tiếp đợt 4', cwd: h.root, env: { GH_CONFIG_DIR: '/empty' }, jsonSchema: { type: 'object' }, permissionMode: 'dontAsk' };
    },
  };
  const id = add(ctx, 'ABC1', 'r', { kind: 'review' });
  await tick(ctx, NOW);
  const { args, env } = calls[0];
  assert.equal(args.at(-1), 'p');
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(env.GH_CONFIG_DIR, '/empty');
  assert.deepEqual([seen[0].dzHome, seen[0].project.key, seen[0].deps], [h.dzHome, 'ABC1', { git: 'fake' }]);
  fs.appendFileSync(ctx.deps.logFileFor(job(ctx, id)), `${JSON.stringify({ type: 'assistant' })}\n`);
  alive.clear();
  await tick(ctx, NOW + 10000);
  assert.equal(calls[1].args.at(-1), 'Làm tiếp đợt 4');
  assert.ok(calls[1].args.includes('--resume'));
});

test('a forbidden permission mode parks the job', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  ctx.handlers.review = { prepare: () => ({ prompt: 'p', cwd: h.root, permissionMode: 'bypassPermissions' }) };
  const id = add(ctx, 'ABC1', 'r', { kind: 'review' });
  await tick(ctx, NOW);
  assert.equal(job(ctx, id).state, 'parked');
  assert.equal(calls.length, 0);
});
