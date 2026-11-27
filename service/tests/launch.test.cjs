const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const { statusLines } = require('../src/status.cjs');
const kv = require('../src/kv.cjs');
const { makeHome, add, fakeWorkers, NOW } = require('./service-fixtures.cjs');

const states = (ctx, ...ids) => ids.map(id => jobs.getJob(ctx.db, id).state);
const decisions = (ctx, code) => ctx.db.prepare('SELECT * FROM decisions WHERE code = ? ORDER BY id').all(code);

function writeLog(ctx, id, ...events) {
  fs.appendFileSync(ctx.deps.logFileFor(jobs.getJob(ctx.db, id)), events.map(e => `${JSON.stringify(e)}\n`).join(''));
}

test('the first attempt sends the handler prompt, a resumed one resumes the session with the short prompt', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls, alive } = fakeWorkers(ctx);
  const id = add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  const { sessionId } = jobs.getJob(ctx.db, id);
  const first = calls[0];
  assert.equal(first.args.at(-1), 'Reply with exactly: OK');
  assert.equal(first.args[first.args.indexOf('--session-id') + 1], sessionId);
  assert.equal(first.args[first.args.indexOf('--tools') + 1], '');
  assert.equal(first.args[first.args.indexOf('--model') + 1], 'haiku');
  assert.equal(first.cwd, path.join(h.dzHome, 'probe'));
  assert.equal(first.env.CLAUDE_CONFIG_DIR, path.join(h.dzHome, 'claude'));
  writeLog(ctx, id, { type: 'assistant', parent_tool_use_id: null });
  alive.clear();
  await tick(ctx, NOW + 10000);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.at(-1), 'Tiếp tục việc đang dở.');
  assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], sessionId);
  assert.ok(!calls[1].args.includes('--session-id'));
  assert.ok(!calls[1].args.includes('Reply with exactly: OK'));
  const [decision] = decisions(ctx, 'X02');
  assert.equal(decision.action, 'resumed');
  assert.equal(decision.job_id, id);
  assert.match(decision.rule_version, /^[0-9a-f]{12}$/);
  assert.equal(JSON.parse(decision.evidence).error, 'no_result');
});

test('three start failures in a row park the job; one tick tries it once; another project still starts', async t => {
  const h = makeHome(t, ['ABC1', 'DEF2']);
  const ctx = h.context();
  let broken = true;
  const { calls } = fakeWorkers(ctx, o => (broken && o.cwd === 'bad' ? new Error('cannot start worker') : null));
  ctx.handlers = { probe: { prepare: job => ({ prompt: 'p', cwd: job.project === 'ABC1' ? 'bad' : h.root }) } };
  const [a, b] = ['ABC1', 'DEF2'].map(key => add(ctx, key, 'x'));
  await tick(ctx, NOW);
  assert.equal(calls.length, 2);
  assert.deepEqual(states(ctx, a, b), ['queued', 'running']);
  assert.equal(jobs.getJob(ctx.db, a).sessionId, null);
  await tick(ctx, NOW + 10000);
  assert.deepEqual(states(ctx, a), ['queued']);
  await tick(ctx, NOW + 20000);
  assert.deepEqual(states(ctx, a), ['parked']);
  assert.match(jobs.getJob(ctx.db, a).parkReason, /cannot start worker/);
  assert.deepEqual(decisions(ctx, 'X08').map(d => d.action), ['start-failed', 'start-failed', 'parked']);
});

test('a resumed job that cannot start keeps its session', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  let broken = false;
  const { calls, alive } = fakeWorkers(ctx, () => (broken ? new Error('x') : null));
  const id = add(ctx, 'ABC1', 'a');
  await tick(ctx, NOW);
  const { sessionId } = jobs.getJob(ctx.db, id);
  writeLog(ctx, id, { type: 'assistant', parent_tool_use_id: null });
  alive.clear();
  broken = true;
  await tick(ctx, NOW + 10000);
  broken = false;
  await tick(ctx, NOW + 20000);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].args[calls[2].args.indexOf('--resume') + 1], sessionId);
  assert.equal(calls[2].args.at(-1), 'Tiếp tục việc đang dở.');
});

test('a log left over from another database is not judged', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { alive } = fakeWorkers(ctx);
  const done = { type: 'result', subtype: 'success', is_error: false, result: 'cũ', permission_denials: [] };
  const id = add(ctx, 'ABC1', 'a');
  for (const name of [`${id}-1`, `${id}-1-00000000`]) fs.writeFileSync(path.join(h.dzHome, 'logs', `${name}.jsonl`), `${JSON.stringify(done)}\n`);
  await tick(ctx, NOW);
  alive.clear();
  ctx.stopping = true;
  await tick(ctx, NOW + 10000);
  assert.equal(jobs.getJob(ctx.db, id).state, 'queued');
});

test('a claude binary that is missing or not executable closes intake for five minutes and is not held against any job', async t => {
  for (const mode of [null, 0o644]) {
    const h = makeHome(t, ['ABC1', 'DEF2']);
    const ctx = h.context();
    const good = ctx.claudeBin;
    ctx.claudeBin = path.join(h.root, 'hong');
    if (mode) fs.writeFileSync(ctx.claudeBin, '', { mode });
    let starts = 0;
    const real = ctx.startWorker;
    ctx.startWorker = options => { starts++; return real(options); };
    const ids = [add(ctx, 'ABC1', 'a'), add(ctx, 'DEF2', 'b')];
    for (let i = 0; i < 8; i++) await tick(ctx, NOW + i * 10000);
    assert.equal(starts, 1);
    await tick(ctx, NOW + 5 * 60000);
    await tick(ctx, NOW + 10 * 60000);
    await tick(ctx, NOW + 15 * 60000);
    assert.equal(starts, 4);
    assert.deepEqual(states(ctx, ...ids), ['queued', 'queued']);
    assert.deepEqual(kv.keys(ctx.db, 'start-failures:'), []);
    assert.equal(h.logs('claude-missing').length, 1);
    assert.deepEqual(h.logs('intake').map(l => l.code), ['X08']);
    const shown = statusLines(ctx, NOW + 15 * 60000 + 1).join('\n');
    assert.match(shown, /Nhận việc: đóng \(X08 tới/);
    assert.match(shown, /Worker: không mở được claude/);
    ctx.claudeBin = good;
    await tick(ctx, NOW + 20 * 60000);
    assert.deepEqual(states(ctx, ...ids), ['running', 'running']);
    assert.doesNotMatch(statusLines(ctx, NOW + 20 * 60000 + 1).join('\n'), /Worker:/);
  }
});

test('a missing working folder is the job\'s own failure, not the machine\'s', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  ctx.handlers = { probe: { prepare: () => ({ prompt: 'p', cwd: path.join(h.root, 'gone') }) } };
  const id = add(ctx, 'ABC1', 'a');
  for (let i = 0; i < 3; i++) await tick(ctx, NOW + i * 10000);
  assert.deepEqual(states(ctx, id), ['parked']);
});

test('a start that works resets the failure count', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const outcomes = [true, true, false, true, true, false];
  const { alive } = fakeWorkers(ctx, () => (outcomes.shift() ? new Error('x') : null));
  const id = add(ctx, 'ABC1', 'a');
  for (let i = 0; i < 3; i++) await tick(ctx, NOW + i * 10000);
  assert.deepEqual(states(ctx, id), ['running']);
  assert.deepEqual(kv.keys(ctx.db, 'start-failures:'), []);
  writeLog(ctx, id, { type: 'assistant', parent_tool_use_id: null });
  alive.clear();
  for (let i = 3; i < 6; i++) await tick(ctx, NOW + i * 10000);
  assert.deepEqual(states(ctx, id), ['running']);
});

test('a worker that could not be marked running is left for the supervisor to adopt', async t => {
  const h = makeHome(t);
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  const id = add(ctx, 'ABC1', 'a');
  ctx.db.exec("CREATE TRIGGER no_run BEFORE UPDATE OF state ON jobs WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'đĩa đầy'); END");
  await tick(ctx, NOW);
  assert.deepEqual(states(ctx, id), ['starting']);
  ctx.db.exec('DROP TRIGGER no_run');
  ctx.deps.findWorkerBySession = () => ({ pid: 900001, pidStart: 's900001' });
  await tick(ctx, NOW + 10000);
  assert.deepEqual(states(ctx, id), ['running']);
  assert.equal(calls.length, 1);
});
