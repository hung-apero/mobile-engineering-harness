const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jobs = require('../src/jobs.cjs');
const store = require('../src/specs/store.cjs');
const commands = require('../src/spec-commands.cjs');
const S = require('../vendor/learn-app/lib/learn-app-state.cjs');
const { createRun, openOnce } = require('../src/specs/kit.cjs');
const { loadProjects } = require('../src/projects.cjs');
const { setup, asked, clarified, put, stateAt, OK } = require('./specs-flow-fixtures.cjs');

const DENIED = { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'x', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'adb devices' } }] };

test('a worker that dies in the clarify segment runs the same segment again with the answers kept', async t => {
  const s = setup(t);
  await s.toQuiz();
  s.answer();
  await s.until(() => s.running().length === 1);
  const before = s.read('questions.md');
  s.alive.clear();
  await s.tick();
  await s.until(() => s.running().length === 1);
  assert.equal(s.running()[0].resumes, 1);
  await s.finish(() => stateAt(s.repo(), 'update-spec'));
  const job = s.ctx.db.prepare("SELECT key FROM jobs WHERE kind = 'spec' ORDER BY id DESC LIMIT 1").get();
  assert.equal(job.key, `${s.id}#clarify-${s.spec().data.serial}`);
  assert.equal(s.spec().data.segment.tries, 2);
  assert.equal(s.read('questions.md'), before);
  await s.finish(repo => clarified(repo));
  assert.equal(s.spec().state, 'review');
});

test('a segment that stops short twice is parked with a dev wait, and retry starts it again', async t => {
  const s = setup(t);
  await s.finish(repo => stateAt(repo, 'scout'));
  assert.equal(s.spec().state, 'asking');
  await s.finish();
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /bước scout/);
  assert.deepEqual(s.waits().map(w => w.role), ['dev']);
  assert.match((await commands.spec(s.ctx, ['retry', String(s.id)], s.now))[0], /asking/);
  assert.equal(s.waits().length, 0);
  await s.finish(repo => asked(repo));
  assert.equal(s.spec().state, 'quiz');
});

test('files decide, not the job result: a failed job with a finished segment goes on', async t => {
  const s = setup(t);
  await s.until(() => s.running().length === 1);
  asked(s.repo());
  s.ctx.db.prepare("UPDATE jobs SET state = 'failed', result = '{\"error\":\"x\"}', finished_at = 1 WHERE kind = 'spec'").run();
  await s.tick();
  assert.equal(s.spec().state, 'quiz');
});

test('a worker result that claims success without files is not believed', async t => {
  const s = setup(t);
  await s.finish(null, { event: { ...OK, result: 'đoạn ask: xong' } });
  assert.equal(s.spec().state, 'asking');
});

test('headless-blocked.json stops the spec with its reason and the right role', async t => {
  for (const [blocked, roles] of [
    [{ step: 'spec', reason: 'preflight: thiếu JDK', missing: ['JDK 17'] }, ['dev']],
    [{ step: 'ask', reason: 'spec thiếu màn kết quả', missing: [] }, ['po', 'dev']],
    [{ step: 'scout', reason: 'Figma trả 403', missing: [] }, ['dev']],
  ]) {
    const s = setup(t);
    await s.finish(repo => put(repo, { 'headless-blocked.json': blocked }));
    assert.equal(s.spec().state, 'needs-input');
    assert.deepEqual([s.spec().data.needs.reason, s.waits().map(w => w.role)], [blocked.reason, roles]);
    assert.ok(s.waits()[0].subject.includes(blocked.reason));
    assert.match(s.waits().at(-1).subject, roles.length > 1 ? /dz spec retry/ : /./);
    await commands.spec(s.ctx, ['retry', String(s.id)], s.now);
    assert.equal(s.waits().length, 0);
    await s.until(() => s.running().length === 1);
    assert.equal(fs.existsSync(path.join(s.repo(), '.learn-app', 'headless-blocked.json')), false);
  }
});

test('a parked worker parks the spec without a second wait and retry reopens that job', async t => {
  const s = setup(t);
  const job = await s.finish(null, { event: DENIED });
  assert.equal(jobs.getJob(s.ctx.db, job.id).state, 'parked');
  assert.equal(s.spec().state, 'parked');
  assert.deepEqual(s.waits().map(w => w.role), ['dev']);
  await commands.spec(s.ctx, ['retry', String(s.id)], s.now);
  assert.equal(s.spec().state, 'asking');
  assert.equal(jobs.getJob(s.ctx.db, job.id).state, 'queued');
  await s.finish(repo => asked(repo));
  assert.equal(s.spec().state, 'quiz');
});

test('dz retry on the job alone also brings a parked spec back', async t => {
  const s = setup(t);
  const job = await s.finish(null, { event: DENIED });
  jobs.retry(s.ctx.db, job.id, s.now);
  await s.finish(repo => asked(repo));
  assert.equal(s.spec().state, 'quiz');
});

test('a crash between the approval and the state change is finished from disk, once', async t => {
  const s = setup(t);
  await s.toReview();
  const { sha } = s.facade.review(s.id);
  const real = s.ctx.specs.runState;
  s.ctx.specs.runState = async (project, repo, args) => {
    await real(project, repo, args);
    throw new Error('service chết');
  };
  store.patchData(s.ctx.db, s.id, { approving: { sha, quote: 'Duyệt', by: 'po', at: s.now } }, s.now);
  const out = await s.facade.approve(s.id, { sha, quote: 'Duyệt' }, 'po', s.now);
  assert.equal(out.ok, false);
  assert.equal(s.spec().state, 'review');
  s.ctx.specs.runState = real;
  store.patchData(s.ctx.db, s.id, { approving: { sha, quote: 'Duyệt', by: 'po', at: s.now } }, s.now);
  await s.tick();
  assert.deepEqual([s.spec().state, s.spec().approvedSha], ['approved', sha]);
  assert.equal(s.read('gates/approvals.md').match(/g1 · PO/g).length, 1);
});

test('a failing approve command keeps the review open and calls the dev', async t => {
  const s = setup(t);
  await s.toReview();
  s.ctx.specs.runState = async () => ({ code: 2, stdout: '', stderr: 'còn thiếu x' });
  const out = await s.facade.approve(s.id, { sha: s.facade.review(s.id).sha, quote: 'Duyệt' }, 'po', s.now);
  assert.equal(out.ok, false);
  assert.equal(s.spec().state, 'review');
  assert.deepEqual(s.waits().map(w => w.role).sort(), ['dev', 'po']);
});

test('a clone with a foreign git setting never runs a command for the PO', async t => {
  const s = setup(t);
  await s.toReview();
  fs.appendFileSync(path.join(s.repo(), '.git', 'config'), '[filter "x"]\n\tclean = touch /tmp/pwned\n');
  const out = await s.facade.approve(s.id, { sha: s.facade.review(s.id).sha, quote: 'Duyệt' }, 'po', s.now);
  assert.equal(out.ok, false);
  assert.match(s.decisions('spec-approve-failed')[0].evidence, /filter/);
  assert.equal(S.readState(s.repo()).gates.g1.status, 'pending');
});

test('a source that cannot be read is tried again with longer gaps, then parked', async t => {
  const s = setup(t, { source: { type: 'url', ref: '332470208' } });
  let reads = 0;
  s.ctx.specs.confluence = () => ({ page: async () => { reads++; throw new Error('mạng'); } });
  await s.tick();
  await s.tick();
  assert.deepEqual([s.spec().state, reads], ['reading', 1]);
  for (let i = 0; i < 4; i++) await s.tick(16 * 60000);
  assert.deepEqual([s.spec().state, reads], ['parked', 5]);
});

test('a missing Figma link waits for the PO, a missing Figma config waits for the dev', async t => {
  const s = setup(t, { figma: null });
  await s.tick();
  assert.deepEqual([s.spec().state, s.spec().data.needs.kind, s.waits().map(w => w.role)], ['needs-input', 'figma', ['po', 'dev']]);
  await commands.spec(s.ctx, ['retry', String(s.id), '--figma', 'https://www.figma.com/design/AbC/x'], s.now);
  await s.tick();
  assert.deepEqual([s.spec().state, s.waits().map(w => w.role)], ['needs-input', ['dev']]);
  const file = path.join(s.ctx.secretsDir, 'figma-read.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'framelink-figma': { command: 'npx' } } }), { mode: 0o600 });
  await commands.spec(s.ctx, ['retry', String(s.id)], s.now);
  await s.until(() => s.running().length === 1);
  assert.deepEqual(JSON.parse(s.read('inputs/headless.json')).figma, { url: 'https://www.figma.com/design/AbC/x' });
  const { args } = s.calls[0];
  assert.equal(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'), fs.readFileSync(file, 'utf8'));
  assert.ok(args.includes('mcp__framelink-figma__get_figma_data'));
});

test('the wait about repeated errors is closed on recovery even after a restart (M5)', async t => {
  const s = setup(t);
  await s.until(() => s.running().length === 1);
  const project = loadProjects(s.ctx.projectsDir, { dzHome: s.ctx.dzHome }).projects.get('ABC1');
  openOnce(createRun(s.ctx, project, s.spec(), s.now), 'step-error', 'dev', 'Spec lỗi liên tục');
  assert.equal(s.ctx.specs.errors.size, 0);
  await s.tick();
  assert.deepEqual(s.waits(), []);
});

test('a missing overlay or harness waits for the dev instead of retrying the read', async t => {
  for (const code of ['OVERLAY', 'HARNESS']) {
    const s = setup(t);
    s.ctx.specs.prepareClone = async () => { throw Object.assign(new Error(`thiếu ${code}`), { code }); };
    await s.tick();
    assert.deepEqual([s.spec().state, s.spec().data.needs.kind, s.waits().map(w => w.role)], ['needs-input', 'harness', ['dev']]);
  }
});
