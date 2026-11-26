const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { setup, BRANCH } = require('./bugs-machine-fixtures.cjs');
const { requestPark } = require('../src/bugs/park-request.cjs');
const { JiraError } = require('../src/bugs/jira.cjs');
const { processStart } = require('../src/worker.cjs');

test('a batch stuck on an error is parked on the next pass, without waiting for its backoff', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('gating'));
  const { before } = s.batch(id).data;
  s.before['landing.changedFiles'] = () => { throw new Error('hỏng mãi'); };
  await s.advance(id);
  assert.equal(requestPark(s.db, id, s.now), true);
  await s.advance(id);
  assert.equal(s.batch(id).state, 'abandoned');
  assert.equal(s.ref(BRANCH), before);
  assert.equal(s.ticket('AAP1-1').state, 'dev');
  assert.deepEqual(s.rows("SELECT key FROM kv WHERE key LIKE 'bug-park:%' OR key LIKE 'bug-batch-error:%'"), []);
  assert.equal(requestPark(s.db, id, s.now), false);
  assert.equal(requestPark(s.db, 999, s.now), false);
});

test('parking finishes although Jira refuses every ticket of the batch', async t => {
  const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'] });
  const id = await s.open();
  await s.until(id, s.kindsOf('fixing'));
  for (const name of ['jira.comment', 'jira.issue']) s.before[name] = () => { throw new JiraError('Issue not found (404)'); };
  requestPark(s.db, id, s.now);
  await s.advance(id);
  assert.equal(s.batch(id).state, 'abandoned');
  assert.deepEqual(['AAP1-1', 'AAP1-2'].map(key => s.ticket(key).state), ['dev', 'dev']);
});

test('a batch that was never claimed can be parked', async t => {
  const s = setup(t);
  const id = await s.open();
  requestPark(s.db, id, s.now);
  await s.advance(id);
  assert.equal(s.batch(id).state, 'abandoned');
  assert.equal(s.ticket('AAP1-1').state, 'dev');
});

test('parking stops the running job of the batch and closes it, other jobs stay', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('fixing'));
  await s.advance(id);
  const child = spawn('/bin/sleep', ['60'], { detached: true, cwd: s.root, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const gone = new Promise(resolve => child.on('exit', (code, signal) => resolve(signal)));
  s.db.prepare("UPDATE jobs SET state = 'running', pid = ?, pid_start = ?, started_at = 1, log_file = '/none'").run(child.pid, processStart(child.pid));
  s.db.prepare("INSERT INTO jobs (project, kind, key, priority, slots, created_at) VALUES ('AAP1', 'bug', ?, 1, 1, 1)").run(`${id}9#r1`);
  requestPark(s.db, id, s.now);
  await s.advance(id);
  assert.equal(await gone, 'SIGTERM');
  assert.deepEqual(s.rows('SELECT key, state FROM jobs ORDER BY id'), [{ key: `${id}#r1`, state: 'failed' }, { key: `${id}9#r1`, state: 'queued' }]);
});
