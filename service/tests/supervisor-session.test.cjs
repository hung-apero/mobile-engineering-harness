const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { supervise } = require('../src/supervisor.cjs');
const { world, ev, rulesFor, NOW, MIN } = require('./supervisor-fixtures.cjs');

const pass = (w, extra = {}) => supervise(w.db, { rulesFor, deps: w.deps, now: NOW, boot: false, ...extra });
const kinds = out => out.actions.map(a => [a.jobId, a.type, a.code]);
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.jsonl`), 'utf8');
const MISSING = 'No conversation found with session ID: 1';
const init = { type: 'system', subtype: 'init' };
const turn = w => id => { const j = w.job(id); return [j.state, j.resume, j.resumes]; };

for (const name of ['claude-sigterm-background', 'claude-background-ceiling', 'claude-sigterm-second-turn']) {
  test(`real log ${name} is resumed with its session, not done`, async () => {
    const w = world();
    const job = w.run('x');
    w.raw(job.id, fixture(name));
    w.die(job);
    assert.deepEqual(kinds(await pass(w, { boot: true })), [[job.id, 'resumed', 'X02']]);
    assert.deepEqual(turn(w)(job.id), ['queued', true, 1]);
    assert.equal(w.job(job.id).sessionId, job.sessionId);
  });
}

test('a clean multi-wake worker that exited with no task left is done', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, init, ev.text(1), ev.tasks('t'), ev.ok(), ev.tasks(), init, ev.text(2), ev.ok());
  w.die(job);
  assert.deepEqual(kinds(await pass(w)), [[job.id, 'done', null]]);
});

test('starting, no process, finished log → done, never run twice', async () => {
  const w = world();
  const id = w.add('x');
  w.claim();
  w.log(id, ev.text(1), ev.ok({ result: 'thật' }));
  w.reopen();
  assert.deepEqual(kinds(await pass(w, { boot: true })), [[id, 'done', null]]);
  assert.equal(w.job(id).result.text, 'thật');
  assert.equal(w.claim(), null);
});

test('starting, no process, partial log → resumed with the same session and a turn taken', async () => {
  const w = world();
  const id = w.add('x');
  const job = w.claim();
  w.log(id, init, ev.text(1));
  assert.deepEqual(kinds(await pass(w, { now: NOW + 60000 })), []);
  assert.deepEqual(kinds(await pass(w, { now: NOW + 60001 })), [[id, 'resumed', 'X02']]);
  assert.deepEqual(turn(w)(id), ['queued', true, 1]);
  const again = w.claim();
  assert.deepEqual([again.resume, again.sessionId], [true, job.sessionId]);
});

test('starting, no process, log ending in X01 or X03 → judged the same way', async () => {
  const w = world();
  const quota = w.add('x');
  const job = w.claim();
  w.log(quota, ev.text(1), ev.quota('rejected', 1), ev.bad());
  const denied = w.add('y');
  w.claim();
  w.log(denied, ev.text(1), ev.bad({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm x' } }] }));
  assert.deepEqual(kinds(await pass(w, { boot: true })), [[quota, 'requeued', 'X01'], [denied, 'parked', 'X03']]);
  assert.deepEqual(turn(w)(quota), ['queued', true, 0]);
  assert.equal(w.job(quota).sessionId, job.sessionId);
});

test('starting, no process, empty log → requeued fresh without a turn', async () => {
  const w = world();
  const id = w.add('x');
  w.claim();
  w.raw(id, '');
  assert.deepEqual(kinds(await pass(w, { boot: true })), [[id, 'requeued', 'X04']]);
  assert.deepEqual([...turn(w)(id), w.job(id).sessionId], ['queued', false, 0, null]);
});

test('a log without an assistant event starts a fresh session and counts the turn', async () => {
  for (const events of [[], [init]]) {
    const w = world();
    const job = w.run('x');
    w.log(job.id, ...events);
    w.die(job);
    const out = await pass(w);
    assert.deepEqual(kinds(out), [[job.id, 'resumed', 'X02']]);
    assert.equal(out.actions[0].freshSession, true);
    assert.deepEqual(turn(w)(job.id), ['queued', false, 1]);
    const again = w.claim();
    assert.equal(again.resume, false);
    assert.ok(again.sessionId);
    assert.notEqual(again.sessionId, job.sessionId);
  }
});

test('a silent worker that never answered is stopped and started fresh, counting the turn', async () => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, init);
  await pass(w);
  assert.deepEqual(kinds(await pass(w, { now: NOW + 30 * MIN })), [[job.id, 'resumed', 'X02']]);
  assert.deepEqual(turn(w)(job.id), ['queued', false, 1]);
});

test('a missing conversation, in a result or on stderr, starts a fresh session and counts the turn', async () => {
  const ways = [w => id => w.log(id, ev.bad({ errors: [MISSING] })), w => id => w.raw(id, `${MISSING}\n`)];
  for (const way of ways) {
    const w = world();
    const job = w.run('x');
    const two = () => ({ rules: { X02: { silent_minutes: 30, max_resumes: 2 } } });
    w.log(job.id, ev.text(1));
    w.die(job);
    await pass(w, { rulesFor: two });
    const second = w.start();
    assert.equal(second.sessionId, job.sessionId);
    way(w)(job.id);
    w.die(second);
    assert.deepEqual(kinds(await pass(w, { rulesFor: two })), [[job.id, 'resumed', 'X02']]);
    assert.deepEqual([...turn(w)(job.id), w.job(job.id).sessionId], ['queued', false, 2, null]);
  }
});

test('a resumed attempt that died before answering keeps the session it already has', async () => {
  const w = world();
  const two = () => ({ rules: { X02: { silent_minutes: 30, max_resumes: 2 } } });
  const job = w.run('x');
  w.log(job.id, ev.text(1));
  w.die(job);
  await pass(w, { rulesFor: two });
  const second = w.start();
  w.log(job.id, init);
  w.die(second);
  await pass(w, { rulesFor: two });
  assert.deepEqual([...turn(w)(job.id), w.job(job.id).sessionId], ['queued', true, 2, job.sessionId]);
});
