const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const specs = require('../src/specs/store.cjs');
const jobs = require('../src/jobs.cjs');
const { controlJob } = require('../src/board/job-control.cjs');
const kv = require('../src/kv.cjs');
const { syncParked } = require('../src/blocks.cjs');
const { createWeb } = require('../src/web/server.cjs');
const { makeHome, NOW } = require('./service-fixtures.cjs');
const { send } = require('./web-fixtures.cjs');

function world(t) {
  const h = makeHome(t, ['ABC1']);
  const ctx = h.context();
  const { db } = ctx;
  const stopped = [];
  const stop = async job => stopped.push(job.id);
  const running = ({ state = 'building', jobState = 'running', kind = 'spec', key } = {}) => {
    const { id: specId } = specs.createSpec(db, { project: 'ABC1', title: 'P15', source: {} }, NOW);
    db.prepare('UPDATE specs SET state = ?, data = ? WHERE id = ?').run(state, JSON.stringify({ repo: path.join(h.root, 'repo'), segment: { name: 'build', serial: 1, tries: 1 } }), specId);
    const { id } = jobs.enqueue(db, { project: 'ABC1', kind, key: key ?? `${specId}#build-1`, priority: 1, slots: 1, payload: {} }, NOW);
    db.prepare("UPDATE jobs SET state = ?, session_id = 'sess-1', pid = 4242, pid_start = 's', started_at = ? WHERE id = ?").run(jobState, NOW, id);
    return { specId, id };
  };
  const alive = { value: false };
  const control = (id, action) => controlJob(ctx, id, action, NOW, { stop, isAlive: () => alive.value });
  return { h, ctx, db, stopped, running, control, alive, spec: id => specs.getSpec(db, id), job: id => jobs.getJob(db, id) };
}

test('pause parks the spec and the job, keeps the session and gives a takeover command', async t => {
  const s = world(t);
  const { specId, id } = s.running();
  const out = await s.control(id, 'pause');
  assert.equal(out.ok, true);
  assert.match(out.takeover, /claude --resume sess-1/);
  assert.deepEqual(s.stopped, [id]);
  const spec = s.spec(specId);
  assert.deepEqual([spec.state, spec.data.parked.jobId, spec.data.parked.from, spec.data.parked.mode], ['parked', id, 'building', 'pause']);
  const job = s.job(id);
  assert.deepEqual([job.state, job.resume, job.sessionId], ['parked', true, 'sess-1']);
});

test('stop drops the session', async t => {
  const s = world(t);
  const { id } = s.running();
  await s.control(id, 'stop');
  assert.deepEqual([s.job(id).state, s.job(id).sessionId, s.job(id).resume], ['parked', null, false]);
});

test('start resumes a paused job with its session and puts the spec back', async t => {
  const s = world(t);
  const { specId, id } = s.running();
  await s.control(id, 'pause');
  await s.control(id, 'start');
  assert.equal(s.spec(specId).state, 'building');
  assert.equal(s.spec(specId).data.parked, null);
  assert.deepEqual([s.job(id).state, s.job(id).resume, s.job(id).sessionId], ['queued', true, 'sess-1']);
});

test('start after stop requeues fresh through spec retry', async t => {
  const s = world(t);
  const { specId, id } = s.running();
  await s.control(id, 'stop');
  await s.control(id, 'start');
  assert.equal(s.spec(specId).state, 'building');
  assert.deepEqual([s.job(id).state, s.job(id).sessionId, s.job(id).resume], ['queued', null, false]);
});

test('invalid actions are refused without changing anything', async t => {
  const s = world(t);
  const refused = async (id, action) => assert.rejects(s.control(id, action), error => error.code === 'INVALID');
  const done = s.running({ jobState: 'done' });
  await refused(done.id, 'pause');
  assert.equal(s.spec(done.specId).state, 'building');
  await refused(s.running({ jobState: 'starting' }).id, 'pause');
  const twice = s.running();
  await s.control(twice.id, 'pause');
  await refused(twice.id, 'pause');
  await refused(s.running().id, 'start');
  await refused(s.running({ kind: 'bug', key: '77#lane-1' }).id, 'pause');
  await refused(9999, 'pause');
  await refused(s.running().id, 'explode');
  assert.deepEqual(s.stopped, [twice.id]);
});

test('the job api needs the operator cookie', async t => {
  const s = world(t);
  const { id } = s.running({ jobState: 'done' });
  const web = createWeb(s.ctx, { facade: s.ctx.facade, port: 0, now: () => NOW });
  const { url } = await web.start();
  t.after(() => web.stop());
  const port = Number(new URL(url).port);
  const post = (target, headers = {}) => send(port, { method: 'POST', url: target, body: '{}', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } });
  assert.equal((await post(`/api/job/${id}/pause`)).status, 403);
  const key = fs.readFileSync(path.join(s.ctx.secretsDir ?? path.join(s.ctx.dzHome, 'secrets'), 'web-operator-token'), 'utf8').trim();
  const login = await send(port, { url: `/?k=${key}` });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const res = await post(`/api/job/${id}/pause`, { cookie });
  assert.equal(res.status, 400);
  assert.match(res.json().error, /đang chạy/);
});

test('start is refused while the paused worker process is still alive', async t => {
  const s = world(t);
  const { id } = s.running();
  await s.control(id, 'pause');
  s.alive.value = true;
  await assert.rejects(s.control(id, 'start'), error => error.code === 'INVALID' && /vẫn đang chạy/.test(error.message));
  assert.equal(s.job(id).state, 'parked');
  s.alive.value = false;
  await s.control(id, 'start');
  assert.equal(s.job(id).state, 'queued');
});

test('a board pause opens no dev reminder wait', async t => {
  const s = world(t);
  const { id } = s.running();
  await s.control(id, 'pause');
  syncParked(s.db, NOW);
  assert.equal(kv.get(s.db, `wait:job:${id}`), null);
});

test('takeover is only for claude jobs and quotes the repo path', async t => {
  const s = world(t);
  const smoke = s.running({ kind: 'build', key: '' });
  const own = s.running();
  s.db.prepare("UPDATE jobs SET key = ? WHERE id = ?").run(`spec-${smoke.specId}#smoke-1`, smoke.id);
  assert.equal((await s.control(smoke.id, 'pause')).takeover, undefined);
  assert.match((await s.control(own.id, 'pause')).takeover, /^cd '[^']+' && /);
});
