const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./bugs-machine-fixtures.cjs');
const { intake } = require('../src/bugs/intake.cjs');
const { loadIssue } = require('../src/bugs/issue-view.cjs');

const ROWS = [
  ['needs-confirm', 'skipped', 'B05', 'po', 'concluded'],
  ['spec-gap', 'skipped', 'B05', 'po', 'concluded'],
  ['conflict', 'skipped', 'B05', 'po', 'concluded'],
  ['needs-info', 'skipped', 'B06', 'qa', 'concluded'],
  ['not-a-bug', 'skipped', 'B07', 'qa', 'concluded'],
  ['duplicate', 'skipped', 'B07', 'qa', 'concluded'],
  ['already-fixed', 'skipped', 'B07', 'qa', 'concluded'],
  ['external', 'skipped', 'B07', 'qa', 'concluded'],
  ['out-of-scope', 'skipped', 'F01', 'dev', 'dev'],
  ['confirmed', 'failed', 'F01', 'dev', 'dev'],
  ['confirmed', 'blocked', 'F01', 'dev', 'dev'],
];

const only = (key, ticket) => (asked => (asked === key ? { key, rootCause: 'căn cứ', question: 'hỏi @ai [~x] dz:1:a', ...ticket } : null));

for (const [verdict, status, code, role, state] of ROWS) {
  test(`${verdict} ${status} is ${code} for ${role} and the other bug still lands`, async t => {
    const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'], kinds: { ticket: only('AAP1-1', { verdict, status }) } });
    const id = await s.open();
    await s.until(id);
    const issue = s.fake.issues['AAP1-1'];
    assert.equal(issue.comments.length, 1);
    assert.match(issue.comments[0], /^\[Claude\] /);
    assert.ok(issue.comments[0].endsWith(`dz:${id}:AAP1-1:${code}`));
    assert.doesNotMatch(issue.comments[0].replace(/dz:\d+:AAP1-1:\w+$/, ''), /@|\[~|dz:\d/);
    assert.equal(issue.status, 'To Do');
    assert.deepEqual(issue.labels, []);
    assert.equal(s.ticket('AAP1-1').state, state);
    assert.equal(s.ticket('AAP1-1').verdict, state === 'dev' ? null : verdict);
    assert.equal(s.waits(role).filter(subject => subject.includes('AAP1-1')).length, 1);
    assert.ok(s.codes('AAP1-1').some(row => row.startsWith(`${code} `)));
    assert.equal(s.ticket('AAP1-2').state, 'done');
  });
}

for (const [name, ticket, code] of [
  ['needs-device', { verdict: 'confirmed', status: 'needs-device' }, 'F05'],
  ['confirmed but skipped by the worker', { verdict: 'confirmed', status: 'skipped' }, 'F01'],
]) {
  test(`${name} goes to the next batch without a comment`, async t => {
    const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'], kinds: { ticket: only('AAP1-1', ticket) } });
    await s.until(await s.open());
    assert.equal(s.ticket('AAP1-1').state, 'accepted');
    assert.deepEqual(s.comments('AAP1-1'), []);
    assert.deepEqual(s.codes('AAP1-1').filter(c => c.includes('batch')), [`${code} next-batch`]);
    assert.equal(s.ticket('AAP1-2').state, 'done');
  });
}

test('a key the worker left out goes to the next batch', async t => {
  const kinds = { bug: job => ({ tickets: [s.approved(job.payload.batchId, 'AAP1-2')] }) };
  const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'], kinds });
  await s.until(await s.open());
  assert.equal(s.ticket('AAP1-1').state, 'accepted');
  assert.equal(s.ticket('AAP1-2').state, 'done');
});

test('a concluded ticket is not accepted again until something new happens', async t => {
  const s = setup(t, { kinds: { ticket: key => ({ key, verdict: 'needs-confirm', status: 'skipped', question: 'q' }) } });
  await s.until(await s.open());
  const poll = async () => intake(s.db, { project: 'AAP1', version: '1.9.2', issues: [await loadIssue(s.jira, 'AAP1-1')], now: s.now });
  assert.deepEqual((await poll()).skipped.map(x => x.code), ['B08']);
  s.fake.issues['AAP1-1'].comments.push('PO: giữ như cũ');
  assert.deepEqual((await poll()).accepted, ['AAP1-1']);
});

test('a reopened ticket moved back to the first waiting status is still not accepted again', async t => {
  const s = setup(t, { issues: { 'AAP1-1': { status: 'Reopened' } }, kinds: { ticket: key => ({ key, verdict: 'not-a-bug', status: 'skipped' }) } });
  await s.until(await s.open());
  assert.equal(s.fake.issues['AAP1-1'].status, 'To Do');
  const result = intake(s.db, { project: 'AAP1', version: '1.9.2', issues: [await loadIssue(s.jira, 'AAP1-1')], now: s.now });
  assert.deepEqual(result.accepted, []);
});

test('a comment written while the batch was running still re-opens the concluded ticket', async t => {
  const s = setup(t, {
    kinds: {
      ticket: key => {
        s.fake.issues[key].comments = ['QA: bổ sung'];
        return { key, verdict: 'needs-info', status: 'skipped', needs: 'video' };
      },
    },
  });
  await s.until(await s.open());
  const result = intake(s.db, { project: 'AAP1', version: '1.9.2', issues: [await loadIssue(s.jira, 'AAP1-1')], now: s.now });
  assert.deepEqual(result.accepted, ['AAP1-1']);
});

test('claiming a ticket again closes the waits it had opened', async t => {
  const s = setup(t, { kinds: { ticket: key => ({ key, verdict: 'needs-confirm', status: 'skipped', question: 'q' }) } });
  await s.until(await s.open());
  assert.equal(s.waits('po').length, 1);
  s.fake.issues['AAP1-1'].comments.push('trả lời');
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'fixing');
  assert.deepEqual(s.waits('po'), []);
});

test('an unreachable waiting status is recorded, not guessed', async t => {
  const transitions = [{ id: '2', name: 'x', to_status: 'In Progress' }];
  const s = setup(t, { issues: { 'AAP1-1': { transitions } }, kinds: { ticket: key => ({ key, verdict: 'not-a-bug', status: 'skipped' }) } });
  await s.until(await s.open());
  assert.equal(s.fake.issues['AAP1-1'].status, 'In Progress');
  assert.ok(s.codes('AAP1-1').includes('X08 no-transition'));
});

test('a ticket taken by a dev between poll and claim is dropped without any write', async t => {
  const s = setup(t, { keys: ['AAP1-1', 'AAP1-2', 'AAP1-3'] });
  const id = await s.open();
  s.fake.issues['AAP1-1'].status = 'In Progress';
  s.fake.issues['AAP1-2'].labels = ['human-only'];
  await s.until(id);
  for (const key of ['AAP1-1', 'AAP1-2']) {
    assert.equal(s.ticket(key).state, 'skipped');
    assert.ok(s.codes(key).includes('B02 skipped'));
    assert.equal(s.writes().some(c => c.args.issue_key === key), false);
  }
  assert.equal(s.ticket('AAP1-3').state, 'done');
});

test('a batch with no ticket left is done without cloning', async t => {
  const s = setup(t);
  const id = await s.open();
  s.fake.issues['AAP1-1'].status = 'In Progress';
  assert.equal((await s.until(id)).state, 'done');
  assert.deepEqual(s.jobKeys(), []);
  assert.equal(s.calls.includes('workspace.ensureClone'), false);
});

test('an unreadable result gets one more round with a note, then the batch is parked', async t => {
  const s = setup(t, { kinds: { bug: () => ({ text: 'không có json' }) } });
  const id = await s.open();
  const batch = await s.until(id);
  assert.equal(batch.state, 'abandoned');
  assert.deepEqual(s.jobKeys(), [`bug ${id}#r1`, `bug ${id}#r2`]);
  assert.match(JSON.parse(s.rows('SELECT payload FROM jobs ORDER BY id')[1].payload).notes[0].text, /không hợp lệ/);
  assert.equal(s.ticket('AAP1-1').state, 'dev');
});

test('a ticket is handed to dev on its third next batch', async t => {
  const s = setup(t, { kinds: { ticket: key => ({ key, verdict: 'confirmed', status: 'needs-device' }) } });
  for (const state of ['accepted', 'accepted', 'dev']) {
    const { id } = state === 'accepted' && s.ticket('AAP1-1') === null ? { id: await s.open() } : replan(s);
    await s.until(id);
    assert.equal(s.ticket('AAP1-1').state, state);
  }
  assert.equal(s.waits('dev').length, 1);
  assert.equal(s.comments('AAP1-1').length, 1);
});

function replan(s) {
  const { planBatches } = require('../src/bugs/intake.cjs');
  return planBatches(s.db, 'AAP1', s.now, { max_bugs: 8, max_hours: 4 })[0];
}
