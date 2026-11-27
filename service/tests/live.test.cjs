const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jobs = require('../src/jobs.cjs');
const kv = require('../src/kv.cjs');
const { makeHome, waitFor, sleep } = require('./service-fixtures.cjs');

const PROMPT = [
  'Use the Bash tool with run_in_background=true to run exactly: python3 -c "import time; time.sleep(60); print(1)"',
  'Then wait for that background task to finish and reply with exactly: SLEPT',
].join(' ');

const WRAPPER = `
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const tools = args.indexOf('--tools');
if (tools !== -1) args[tools + 1] = 'Bash';
const dash = args.lastIndexOf('--');
const head = args.slice(0, dash);
if (!head.includes('--resume')) args[args.length - 1] = ${JSON.stringify(PROMPT)};
args.splice(dash, 0, '--allowedTools', 'Bash');
const child = spawn('claude', args, { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
`;

test('live: a real claude worker survives killing the service and finishes exactly once', { skip: process.env.DZ_LIVE !== '1', timeout: 300000 }, async t => {
  const h = makeHome(t, ['ABC1']);
  const wrapper = path.join(h.root, 'live-claude.cjs');
  fs.writeFileSync(wrapper, WRAPPER);
  const bin = path.join(h.root, 'live-claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${wrapper}" "$@"\n`, { mode: 0o755 });
  delete h.env.FAKE_CLAUDE_SCRIPT;
  h.env.DZ_CLAUDE_BIN = bin;
  h.env.DZ_CLAUDE_CONFIG = 'shared';
  const id = Number(h.dz('probe', 'ABC1').stdout.match(/#(\d+)/)[1]);
  const first = h.run();
  const ctx = h.context();
  const running = await waitFor(() => {
    const job = jobs.getJob(ctx.db, id);
    return job.state === 'running' && job.pid && job;
  }, 60000);
  await sleep(20000);
  first.kill('SIGKILL');
  await first.done;
  assert.ok(ctx.deps.findWorkerBySession(running.sessionId), 'worker must outlive the service');
  const second = h.run();
  const done = await waitFor(() => {
    const job = jobs.getJob(ctx.db, id);
    return job.state === 'done' && job;
  }, 200000);
  assert.equal(done.attempt, 1);
  assert.equal(done.pid, running.pid);
  assert.equal(done.pidStart, running.pidStart);
  assert.equal(jobs.listJobs(ctx.db).filter(job => job.project === 'ABC1').length, 1);
  assert.equal(typeof kv.get(ctx.db, 'quota')?.utilization, 'number');
  second.kill('SIGINT');
  await second.done;
});

test('live: claude with the shared login answers under the sandbox profile', { skip: process.env.DZ_LIVE !== '1', timeout: 180000 }, async t => {
  const h = makeHome(t, ['ABC1']);
  h.project('ABC1', { live: true });
  delete h.env.FAKE_CLAUDE_SCRIPT;
  h.env.DZ_CLAUDE_BIN = 'claude';
  h.env.DZ_CLAUDE_CONFIG = 'shared';
  const id = Number(h.dz('probe', 'ABC1').stdout.match(/#(\d+)/)[1]);
  const service = h.run();
  const ctx = h.context();
  const running = await waitFor(() => {
    const job = jobs.getJob(ctx.db, id);
    return job.pid && job;
  }, 60000);
  assert.equal(fs.statSync(path.join(h.dzHome, 'runs', String(id), 'profile.sb')).mode & 0o777, 0o600);
  assert.equal(ctx.deps.findWorkerBySession(running.sessionId)?.pid, running.pid);
  const done = await waitFor(() => {
    const job = jobs.getJob(ctx.db, id);
    return ['done', 'failed', 'parked'].includes(job.state) && job;
  }, 120000);
  assert.equal(done.state, 'done', JSON.stringify(done.result));
  assert.match(done.result.text ?? JSON.stringify(done.result), /OK/);
  await waitFor(() => !fs.existsSync(path.join(h.dzHome, 'runs', String(id))), 30000);
  service.kill('SIGINT');
  await service.done;
});
