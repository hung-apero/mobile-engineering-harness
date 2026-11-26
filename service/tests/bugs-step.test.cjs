const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const polling = require('../src/bugs/polling.cjs');
const { bugStep, backoffKey } = require('../src/bugs/step.cjs');
const health = require('../src/health.cjs');
const jobs = require('../src/jobs.cjs');
const { setup, issue, NOW, MIN } = require('./bugs-step-fixtures.cjs');

const HOUR = 60 * MIN;
const decisions = (ctx, code) => ctx.db.prepare('SELECT action, evidence FROM decisions WHERE code = ? ORDER BY id').all(code);
const openWaits = ctx => ctx.db.prepare("SELECT role, subject FROM waits WHERE state = 'open'").all();
const x06Waits = ctx => openWaits(ctx).filter(w => w.subject.includes('X06'));
const failing = ctx => {
  const calls = [];
  ctx.bugs.jira = async () => ({
    search: async () => {
      calls.push(1);
      throw new Error('Jira 503');
    },
  });
  return calls;
};

test('polling happens only when due: every 3 minutes, every 15 after 24 quiet hours', async t => {
  const s = setup(t);
  s.turnOn('ABC1', '1.9.2', NOW - 5 * MIN);
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.searches().length, 1);
  await bugStep(s.ctx, s.config(), NOW + 3 * MIN - 1);
  assert.equal(s.searches().length, 1);
  await bugStep(s.ctx, s.config(), NOW + 3 * MIN);
  assert.equal(s.searches().length, 2);
  s.ctx.db.prepare('UPDATE versions SET baseline_at = ?, last_new_at = NULL').run(NOW - 30 * HOUR);
  await bugStep(s.ctx, s.config(), NOW + 10 * MIN);
  assert.equal(s.searches().length, 2);
  await bugStep(s.ctx, s.config(), NOW + 3 * MIN + 15 * MIN);
  assert.equal(s.searches().length, 3);
});

test('polling off: no search, but a running batch still advances', async t => {
  const s = setup(t);
  store.ensureVersion(s.ctx.db, { project: 'ABC1', version: '1.9.2' });
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.searches().length, 0);
  assert.equal(s.advances.length, 1);
});

test('a poll accepts the new bug, plans a batch once a poll finds nothing new, and advances it in the same step', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue('To Do') } });
  s.turnOn();
  await bugStep(s.ctx, s.config(), NOW);
  assert.deepEqual(store.listTickets(s.ctx.db, { project: 'ABC1' }).map(x => [x.key, x.state]), [['ABC1-1', 'accepted']]);
  assert.equal(s.advances.length, 0);
  await bugStep(s.ctx, s.config(), NOW + 3 * MIN);
  const [ticket] = store.listTickets(s.ctx.db, { project: 'ABC1' });
  assert.equal(ticket.state, 'batched');
  assert.equal(s.advances.length, 1);
  assert.deepEqual(s.advances[0].batch.keys, ['ABC1-1']);
  assert.equal(s.advances[0].project.key, 'ABC1');
  assert.equal(s.advances[0].limits.batch.max_bugs, 8);
  assert.equal(s.advances[0].rules.F01.fix_rounds, 2);
  assert.equal(s.advances[0].now, NOW + 3 * MIN);
});

test('--only keeps the key filter in the JQL and drops every other bug in intake', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue(), 'ABC1-2': issue() } });
  s.turnOn();
  kv.set(s.ctx.db, `bug-only:ABC1:1.9.2`, ['ABC1-2'], NOW);
  await bugStep(s.ctx, s.config(), NOW);
  assert.match(s.searches()[0].args.jql, /AND key in \(ABC1-2\)/);
  assert.deepEqual(store.listTickets(s.ctx.db, { project: 'ABC1' }).map(x => x.key), ['ABC1-2']);
});

test('the baseline from --base is the poll baseline in the JQL', async t => {
  const s = setup(t);
  s.turnOn();
  s.ctx.db.prepare('UPDATE versions SET baseline_at = ?').run(Date.parse('2026-11-20T00:00:00+07:00'));
  await bugStep(s.ctx, s.config(), NOW);
  assert.match(s.searches()[0].args.jql, /created >= "2026-11-20 00:00"/);
});

test('a reopened-too-often bug opens a dev wait B09 and is not accepted', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue('Reopened') } });
  s.turnOn();
  store.ensureVersion(s.ctx.db, { project: 'ABC1', version: '1.9.2' });
  s.ctx.db.prepare("INSERT INTO tickets (project, key, version, priority, state, reopen_count, fingerprint, updated_at) VALUES ('ABC1', 'ABC1-1', '1.9.2', 1, 'done', 2, 'x', 1)").run();
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(store.getTicket(s.ctx.db, 'ABC1', 'ABC1-1').state, 'dev');
  assert.equal(decisions(s.ctx, 'B09')[0].action, 'give-dev');
  assert.deepEqual(openWaits(s.ctx).map(w => w.role), ['dev']);
  await bugStep(s.ctx, s.config(), NOW + 3 * MIN);
  assert.equal(openWaits(s.ctx).length, 1);
});

test('X06: a failing Jira backs off 3, 6, 12, 15, 15 minutes and is not asked sooner', async t => {
  const s = setup(t);
  s.turnOn();
  const calls = failing(s.ctx);
  const at = [0, 3, 9, 21, 36];
  for (const minute of at) {
    await bugStep(s.ctx, s.config(), NOW + minute * MIN);
    await bugStep(s.ctx, s.config(), NOW + minute * MIN + 1);
  }
  assert.equal(calls.length, 5);
  const retries = decisions(s.ctx, 'X06').map(d => JSON.parse(d.evidence).retryAt);
  assert.deepEqual(retries.map((r, i) => (r - NOW - at[i] * MIN) / MIN), [3, 6, 12, 15, 15]);
  await bugStep(s.ctx, s.config(), NOW + 36 * MIN + 14 * MIN);
  assert.equal(calls.length, 5);
  await bugStep(s.ctx, s.config(), NOW + 36 * MIN + 15 * MIN);
  assert.equal(calls.length, 6);
});

test('X06: 30 minutes of failures open one dev wait, the first success closes it and clears the backoff', async t => {
  const s = setup(t);
  s.turnOn();
  failing(s.ctx);
  for (const minute of [0, 3, 9, 21]) await bugStep(s.ctx, s.config(), NOW + minute * MIN);
  assert.deepEqual(x06Waits(s.ctx), []);
  for (const minute of [36, 51]) await bugStep(s.ctx, s.config(), NOW + minute * MIN);
  assert.deepEqual(x06Waits(s.ctx).map(w => w.role), ['dev']);
  assert.match(x06Waits(s.ctx)[0].subject, /X06/);
  s.ctx.bugs.jira = async () => ({ search: async () => [] });
  await bugStep(s.ctx, s.config(), NOW + 66 * MIN);
  assert.deepEqual(x06Waits(s.ctx), []);
  assert.equal(kv.get(s.ctx.db, backoffKey('ABC1')), null);
});

test('a Jira failure never stops running batches from advancing', async t => {
  const s = setup(t);
  s.turnOn();
  failing(s.ctx);
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.advances.length, 1);
});

test('a paused project does not poll or plan, but its running batch is still advanced', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue() } });
  s.turnOn();
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  health.setProjectState(s.ctx.db, 'ABC1', { paused: true });
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.searches().length, 0);
  assert.equal(s.advances.length, 1);
  assert.deepEqual(store.listTickets(s.ctx.db, { project: 'ABC1' }), []);
});

test('a concluded ticket with only our [Claude] comment is not re-accepted; a new QA comment is', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue('To Do', { comments: ['[Claude] cần thêm thông tin'], labels: ['claude-fixing'] }) } });
  s.turnOn();
  store.ensureVersion(s.ctx.db, { project: 'ABC1', version: '1.9.2' });
  const toIssueView = require('../src/bugs/issue-view.cjs');
  const { fingerprintOf } = require('../src/bugs/intake.cjs');
  const fingerprint = fingerprintOf(toIssueView.toIssue({ key: 'ABC1-1', status: { name: 'To Do' }, labels: [], comments: [] }));
  s.ctx.db.prepare("INSERT INTO tickets (project, key, version, priority, state, verdict, fingerprint, updated_at) VALUES ('ABC1', 'ABC1-1', '1.9.2', 1, 'concluded', 'B06', ?, 1)").run(fingerprint);
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(store.getTicket(s.ctx.db, 'ABC1', 'ABC1-1').state, 'concluded');
  s.fake.issues['ABC1-1'].comments.push('QA: đã gửi log');
  await bugStep(s.ctx, s.config(), NOW + 3 * MIN);
  assert.equal(store.getTicket(s.ctx.db, 'ABC1', 'ABC1-1').state, 'accepted');
});

test('human-only on the re-read is honoured', async t => {
  const s = setup(t, { issues: { 'ABC1-1': issue('To Do', { labels: ['human-only'] }) } });
  s.turnOn();
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(store.getTicket(s.ctx.db, 'ABC1', 'ABC1-1').state, 'skipped');
});

test('a project blocked by X07 neither polls nor advances', async t => {
  const s = setup(t);
  s.turnOn();
  for (const key of ['a', 'b', 'c']) {
    const { id } = jobs.enqueue(s.ctx.db, { project: 'ABC1', kind: 'probe', key, priority: 1, slots: 1 }, NOW);
    s.ctx.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(id);
    jobs.finish(s.ctx.db, id, 'failed', null, NOW);
  }
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.searches().length, 0);
});

test('a disabled project is not touched, another project still is', async t => {
  const s = setup(t, { keys: ['ABC1', 'DEF2'] });
  s.h.project('DEF2', { enabled: false });
  s.turnOn('ABC1');
  s.turnOn('DEF2');
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.searches().length, 1);
});

test('one project failing does not stop another', async t => {
  const s = setup(t, { keys: ['ABC1', 'DEF2'] });
  s.turnOn('ABC1');
  s.turnOn('DEF2');
  const real = s.ctx.bugs.jira;
  s.ctx.bugs.jira = async project => {
    if (project.key === 'ABC1') throw new Error('không có cấu hình');
    return real(project);
  };
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.searches().length, 1);
  assert.equal(decisions(s.ctx, 'X06').length, 1);
});

test('bugStep is single-flight: a second call joins the pending one and never starts another', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const s = setup(t, { advance: () => gate.then(() => ({ changed: false })) });
  s.turnOn();
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  const first = bugStep(s.ctx, s.config(), NOW);
  const second = bugStep(s.ctx, s.config(), NOW + 10000);
  assert.equal(first, second);
  assert.equal(s.ctx.bugStepPending, first);
  release();
  await first;
  assert.equal(s.advances.length, 1);
  assert.equal(s.ctx.bugStepPending, null);
});

test('a rejecting advance never escapes bugStep and is logged', async t => {
  const s = setup(t, { advance: () => { throw new Error('hỏng bất ngờ'); } });
  s.turnOn();
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  await assert.doesNotReject(bugStep(s.ctx, s.config(), NOW));
  const logged = s.h.logs('bug-step-error');
  assert.equal(logged[0].project, 'ABC1');
  assert.match(logged[0].error, /hỏng bất ngờ/);
});

test('a batch is advanced again while it changes, at most 5 passes per step', async t => {
  const s = setup(t, { advance: () => ({ changed: true, phase: 'fixing' }) });
  s.turnOn();
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.advances.length, 5);
});

test('a batch that stops changing is advanced once more than it changed, and a finished batch no more', async t => {
  let n = 0;
  const s = setup(t, { advance: ({ batch }) => {
    if (++n === 2) s.ctx.db.prepare("UPDATE batches SET state = 'done' WHERE id = ?").run(batch.id);
    return { changed: true };
  } });
  s.turnOn();
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.advances.length, 2);
});

test('ctx.stopping: nothing new is started', async t => {
  const s = setup(t);
  s.turnOn();
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  s.ctx.stopping = true;
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.searches().length, 0);
  assert.equal(s.advances.length, 0);
});

test('release is checked at most every 15 minutes and at once after a batch is done', async t => {
  const s = setup(t, { advance: ({ batch }) => {
    s.ctx.db.prepare("UPDATE batches SET state = 'done' WHERE id = ?").run(batch.id);
    return { changed: true };
  } });
  s.ctx.bugs.baseContains = async () => ({ ok: false, detail: 'x' });
  s.ctx.bugs.versionTip = async () => ({ sha: 'b'.repeat(40), tree: 'a'.repeat(40) });
  kv.set(s.ctx.db, 'e2e:ABC1:1.9.2', { result: { tree: 'a'.repeat(40), status: 'pass', failures: [], incomplete: [] } }, NOW);
  s.turnOn();
  const at = () => kv.get(s.ctx.db, 'bug-release:ABC1:1.9.2')?.at;
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(at(), NOW);
  await bugStep(s.ctx, s.config(), NOW + MIN);
  assert.equal(at(), NOW);
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES ('ABC1', '1.9.2', 'normal', 'running', '[]', 1, 1)").run();
  await bugStep(s.ctx, s.config(), NOW + 2 * MIN);
  assert.equal(at(), NOW + 2 * MIN);
  assert.equal(decisions(s.ctx, 'R01').length, 1);
});

test('a version closed in the store is not polled', async t => {
  const s = setup(t);
  s.turnOn();
  s.ctx.db.prepare("UPDATE versions SET state = 'closed'").run();
  await bugStep(s.ctx, s.config(), NOW);
  assert.equal(s.searches().length, 0);
});
