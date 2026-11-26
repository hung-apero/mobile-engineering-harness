const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { g } = require('./bugs-git-fixtures.cjs');
const { setup, step } = require('./bugs-machine-fixtures.cjs');
const health = require('../src/health.cjs');

const TWO = ['AAP1-1', 'AAP1-2'];
const jobRows = s => s.rows('SELECT kind, key, state FROM jobs ORDER BY id').map(r => `${r.kind} ${r.key.split('#')[1]} ${r.state}`);

test('a distribution with an unknown result parks the batch and asks a person to check Firebase', async t => {
  const s = setup(t, { kinds: { build: job => (job.payload.distribute ? [step('verify'), step('assemble'), { ...step('distribute', false), unknown: true }] : undefined) } });
  const id = await s.open();
  assert.equal((await s.until(id)).state, 'abandoned');
  assert.ok(s.codes().includes('Q04 distribute-unknown'));
  assert.equal(s.waits('dev').filter(w => /Firebase/.test(w)).length, 1);
  assert.equal(s.jobKeys().filter(k => k.endsWith('#d1')).length, 1);
});

test('a round-2 result that reuses the branch of an approved lane counts a try for the bug it replaced', async t => {
  const kinds = {
    reviewLane: (l, job) => l.keys[0] === 'AAP1-1' && job.key.endsWith('v1') && { verdict: 'changes', findings: [{ file: 'A.kt', line: 3, severity: 'major', text: 'x' }] },
    ticket: (key, job) => job.payload.round === 2 && { ...s.approved(job.payload.batchId, 'AAP1-2', { 'again.txt': 'x\n' }, { from: `fix/aap1-2-${job.payload.batchId}` }), key },
  };
  const s = setup(t, { keys: TWO, kinds });
  await s.until(await s.open());
  assert.equal(s.ticket('AAP1-2').state, 'accepted');
  assert.ok(s.codes('AAP1-2').includes('F01 next-batch'));
});

test('a parked batch closes its parked job together with its wait', async t => {
  const { syncParked } = require('../src/blocks.cjs');
  const s = setup(t, { kinds: { bug: () => 'parked' } });
  const id = await s.open();
  await s.until(id, s.kindsOf('fixing'));
  await s.advance(id);
  s.work();
  syncParked(s.db, s.now);
  assert.equal(s.waits('dev').length, 1);
  await s.until(id);
  assert.deepEqual(jobRows(s), ['bug r1 failed']);
  assert.equal(s.waits('dev').length, 1);
  assert.match(s.waits('dev')[0], /Đợt bug/);
  assert.equal(health.projectBlocked(s.db, 'AAP1', { X07: { max_consecutive_failures: 1 } }), false);
});

test('a paused project does not rebuild the review or gate tree on every pass', async t => {
  const s = setup(t);
  const id = await s.open();
  for (const phase of ['reviewing', 'gating']) {
    await s.until(id, s.kindsOf(phase));
    health.setProjectState(s.db, 'AAP1', { paused: true });
    const count = () => s.calls.filter(c => c === 'landing.versionWorktree').length;
    const trees = count();
    for (let i = 0; i < 3; i++) assert.equal((await s.advance(id)).changed, false);
    assert.equal(count(), trees);
    health.setProjectState(s.db, 'AAP1', { paused: false });
  }
});

test('a green gate with a red lint records why it was accepted and keeps the lint log', async t => {
  const s = setup(t, { commands: { lint: ['x'] }, kinds: { gate: job => {
    const { gateDir } = require('../src/handlers/gate.cjs');
    const dir = gateDir(job.payload, { dzHome: s.dzHome, project: s.project });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/2-lint.log`, 'Cũ.kt:1 lỗi cũ\n');
    return [step('compile'), step('unitTest'), step('lint', false)];
  } } });
  const id = await s.open();
  assert.equal((await s.until(id)).state, 'done');
  const row = s.rows("SELECT evidence FROM decisions WHERE action = 'gate-green'")[0];
  assert.match(JSON.parse(row.evidence).note, /lint đỏ/);
  const kept = `${s.dzHome}/logs/batches/AAP1-${id}`;
  assert.match(fs.readFileSync(`${kept}/${fs.readdirSync(kept).find(n => n.startsWith('gate-'))}/2-lint.log`, 'utf8'), /lỗi cũ/);
});

test('an open batch prunes old abandoned directories once a day even when intake is closed', async t => {
  const s = setup(t);
  const id = await s.open();
  s.db.prepare("INSERT INTO batches (id, project, version, kind, state, keys, opened_at, updated_at) VALUES (99, 'AAP1', '1.9.2', 'normal', 'abandoned', '[]', 1, 1)").run();
  fs.mkdirSync(s.repo(99), { recursive: true });
  g(s.root, 'init', '-q', '--bare', s.mirror);
  s.freeGb = 1;
  for (let i = 0; i < 2; i++) await s.advance(id);
  assert.equal(fs.existsSync(s.repo(99)), false);
  assert.equal(s.calls.filter(c => c === 'cleanup.pruneAbandoned').length, 1);
});

test('the build starts from a tracked tree that equals the gated commit', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('building'));
  const tree = s.repo(id).replace(/repo$/, 'gate');
  fs.writeFileSync(`${tree}/a.txt`, 'đổi lúc chạy cổng\n');
  await s.advance(id);
  assert.equal(g(tree, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(g(tree, 'rev-parse', 'HEAD'), s.batch(id).data.sha);
});

test('a ticket that left In Progress gets the comment but is not moved to Resolved', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('delivering'));
  s.fake.issues['AAP1-1'].status = 'Reopened';
  await s.until(id);
  assert.equal(s.fake.issues['AAP1-1'].status, 'Reopened');
  assert.equal(s.comments('AAP1-1').length, 1);
  assert.ok(s.codes('AAP1-1').includes('X08 not-in-progress'));
});
