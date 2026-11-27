const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { tick } = require('../src/tick.cjs');
const { startWorker, stopWorker, findWorkerBySession, isSameProcess } = require('../src/worker.cjs');
const { statusLines } = require('../src/status.cjs');
const jobs = require('../src/jobs.cjs');
const { world, ON_MAC } = require('./sandbox-fixtures.cjs');
const { makeHome, add, fakeWorkers, waitFor, writeScript, NOW } = require('./service-fixtures.cjs');

const RUN_STEP = path.join(__dirname, '..', 'src', 'run-step.cjs');
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function start(w, contained, { bin, args }) {
  const logFile = path.join(w.h.dzHome, 'logs', `${crypto.randomUUID()}.jsonl`);
  const started = startWorker({ bin, args, env: contained.env, cwd: w.repo, logFile, sandbox: contained.sandbox });
  return { ...started, logFile };
}

test('a sandboxed worker is found by its session, keeps its argv and dies with its whole tree', ON_MAC, async t => {
  const w = world(t);
  const contained = w.box();
  const sessionId = crypto.randomUUID();
  const bin = writeScript(path.join(w.h.root, 'tree'), 'sleep 300 & echo $! > kids; (sleep 300 & echo $! >> kids; wait) & perl -e "use POSIX; setpgid(0,0); exec q(sleep), 300" & echo $! >> kids; wait');
  const { pid, pidStart } = start(w, contained, { bin, args: ['-p', '--session-id', sessionId, '--', 'prompt'] });
  const kids = await waitFor(() => {
    const file = path.join(w.repo, 'kids');
    const found = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(Number) : [];
    return found.length === 3 && found;
  });
  assert.deepEqual(findWorkerBySession(sessionId), { pid, pidStart });
  assert.ok(isSameProcess(pid, pidStart));
  assert.match(execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }), new RegExp(`tree -p --session-id ${sessionId} -- prompt`));
  assert.ok(kids.every(alive));
  assert.equal(await stopWorker(pid, pidStart, 3000), true);
  assert.deepEqual(kids.filter(alive), []);
});

test('the worker writes its log through the open descriptor although the logs folder is closed to it', ON_MAC, async t => {
  const w = world(t);
  const bin = writeScript(path.join(w.h.root, 'say'), 'echo hello; cat "$DZ_PROBE_FILE"');
  const contained = w.box({}, { env: { DZ_PROBE_FILE: w.at('secrets/t') } });
  const { logFile } = start(w, contained, { bin, args: [] });
  const text = await waitFor(() => fs.readFileSync(logFile, 'utf8').includes('not permitted') && fs.readFileSync(logFile, 'utf8'));
  assert.match(text, /^hello\n/);
  assert.doesNotMatch(text, /BIMAT/);
});

test('a missing program under the sandbox is still a machine wide start failure', ON_MAC, t => {
  const w = world(t);
  const contained = w.box();
  assert.throws(() => start(w, contained, { bin: path.join(w.h.root, 'khong-co'), args: [] }), { machineWide: true });
});

test('run-step works under the sandbox: steps run, a timeout kills the step, the spec folder is writable', ON_MAC, async t => {
  const w = world(t);
  const dir = path.join(w.root, 'batches', '1', 'gate-1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ steps: [
    { name: 'ok', argv: ['/bin/sh', '-c', `echo done > out; cat "${w.at('secrets/t')}" || echo blocked; security find-generic-password -s "Claude Code-credentials" || echo no-keychain`], cwd: w.repo, timeoutMs: 30000 },
    { name: 'slow', argv: ['/bin/sleep', '60'], cwd: w.repo, timeoutMs: 300 },
  ] }));
  const command = { bin: process.execPath, args: [RUN_STEP, path.join(dir, 'spec.json')] };
  const contained = w.box({ kind: 'gate' }, { command });
  const out = w.run(contained, [command.bin, ...command.args, '--session-id', 's1'], { timeout: 60000 });
  assert.equal(out.code, 1, out.err);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  assert.deepEqual(result.steps.map(s => [s.name, s.ok, s.timedOut]), [['ok', true, false], ['slow', false, true]]);
  assert.match(result.steps[0].tail, /blocked/);
  assert.match(result.steps[0].tail, /no-keychain/);
  assert.equal(fs.existsSync(path.join(w.repo, 'out')), true);
});

test('a gate worker cannot turn the worktree link of the mirror into another repository', ON_MAC, t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.repo, '.git'), 'gitdir: /x\n');
  const contained = w.box({ kind: 'gate' }, { command: { bin: process.execPath, args: [RUN_STEP, path.join(w.root, 'batches', '1', 'gate-1', 'spec.json')] } });
  assert.notEqual(w.sh(contained, 'echo y > .git').code, 0);
  assert.notEqual(w.sh(contained, 'rm .git').code, 0);
});

test('without sandbox-exec a live project starts nothing and dev is told once; a dry one still runs', async t => {
  const h = makeHome(t, ['ABC1', 'DEF2']);
  h.project('ABC1', { live: true });
  const ctx = h.context({ sandboxBin: path.join(h.root, 'khong-co') });
  const { calls } = fakeWorkers(ctx);
  const [live, dry] = ['ABC1', 'DEF2'].map(key => add(ctx, key, 'x'));
  for (let i = 0; i < 2; i++) await tick(ctx, NOW + i * 10000);
  assert.deepEqual([live, dry].map(id => jobs.getJob(ctx.db, id).state), ['queued', 'running']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sandbox, undefined);
  const waits = () => ctx.db.prepare("SELECT state FROM waits WHERE subject LIKE '%sandbox-exec%'").all().map(row => row.state);
  assert.deepEqual(waits(), ['open']);
  assert.match(statusLines(ctx, NOW).join('\n'), /Sandbox: THIẾU/);
  delete ctx.sandboxBin;
  if (process.platform !== 'darwin') return;
  await tick(ctx, NOW + 30000);
  assert.equal(jobs.getJob(ctx.db, live).state, 'running');
  assert.ok(calls[1].sandbox.profile.startsWith(path.join(h.dzHome, 'runs', String(live))));
  assert.equal(fs.statSync(calls[1].sandbox.profile).mode & 0o777, 0o600);
  assert.equal(waits().includes('open'), false);
  assert.match(statusLines(ctx, NOW).join('\n'), /Sandbox: bật/);
});

test('DZ_SANDBOX=off starts workers without it and status says so', async t => {
  const h = makeHome(t);
  h.env.DZ_SANDBOX = 'off';
  h.project('ABC1', { live: true });
  const ctx = h.context();
  const { calls } = fakeWorkers(ctx);
  add(ctx, 'ABC1', 'x');
  await tick(ctx, NOW);
  assert.equal(calls[0].sandbox, undefined);
  assert.match(statusLines(ctx, NOW).join('\n'), /Sandbox: TẮT theo DZ_SANDBOX=off/);
});

test('each job gets its own Gradle and Kotlin daemons, on top of the GRADLE_OPTS of the machine', ON_MAC, t => {
  const w = world(t);
  w.ctx.env.GRADLE_OPTS = '-Dx=1';
  const { env } = w.box({ id: 7 });
  const work = path.join(w.h.dzHome, 'runs', '7', 'work');
  assert.equal(env.GRADLE_OPTS, `-Dx=1 -Dorg.gradle.daemon.registry.base=${work}/gradle -Dorg.gradle.daemon.idletimeout=600000 -Dkotlin.daemon.options=runFilesPath=${work}/kotlin,autoshutdownIdleSeconds=600`);
});
