const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const worker = require('../src/worker.cjs');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.cjs');
const WORKER_SRC = path.join(__dirname, '..', 'src', 'worker.cjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dz-w-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SESSION = '3f2b8c1e-aaaa-4bbb-8ccc-123456789abc';

async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error('timeout');
}

function launch(script, extra = {}) {
  const dir = tmp();
  const logFile = path.join(dir, 'logs', 'w.log');
  const env = { ...process.env, FAKE_CLAUDE_SCRIPT: JSON.stringify(script) };
  const started = worker.startWorker({ bin: process.execPath, args: [FAKE, ...(extra.args || [])], env, cwd: dir, logFile });
  return { dir, logFile, ...started };
}

const killGroup = pid => { try { process.kill(-pid, 'SIGKILL'); } catch {} };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('args always contain -p, --output-format stream-json, --verbose, --strict-mcp-config, --setting-sources project; never bypassPermissions or dangerously-skip-permissions', () => {
  const args = worker.workerArgs({ prompt: 'hi', sessionId: SESSION, allowedTools: ['Read', 'Bash(git:*)'], disallowedTools: ['WebFetch'], mcpConfig: '/x/mcp.json', pluginDirs: ['/p1', '/p2'], model: 'opus' });
  assert.ok(args.includes('-p'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--verbose'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'project');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '/x/mcp.json');
  assert.equal(args.filter(a => a === '--plugin-dir').length, 2);
  const joined = args.join(' ');
  assert.ok(!/bypassPermissions|dangerously-skip-permissions/.test(joined));
  const minimal = worker.workerArgs({ prompt: 'hi' }).join(' ');
  assert.ok(!/bypassPermissions|dangerously-skip-permissions/.test(minimal));
});

test('prompt comes last after --', () => {
  const args = worker.workerArgs({ prompt: '--dangerously-skip-permissions do it', sessionId: SESSION, allowedTools: ['Read', 'Edit'], disallowedTools: ['WebFetch', 'Task'] });
  assert.equal(args[args.length - 1], '--dangerously-skip-permissions do it');
  assert.equal(args[args.length - 2], '--');
  assert.equal(args.indexOf('--'), args.length - 2);
  const allowedAt = args.indexOf('--allowedTools');
  assert.deepEqual(args.slice(allowedAt, allowedAt + 3), ['--allowedTools', 'Read', 'Edit']);
  const deniedAt = args.indexOf('--disallowedTools');
  assert.deepEqual(args.slice(deniedAt, deniedAt + 3), ['--disallowedTools', 'WebFetch', 'Task']);
});

test('tools: an empty list disables every tool, a list is joined, absent adds nothing', () => {
  const at = args => args[args.indexOf('--tools') + 1];
  const none = worker.workerArgs({ prompt: 'p', tools: [], model: 'haiku' });
  assert.equal(at(none), '');
  assert.deepEqual(none.slice(-2), ['--', 'p']);
  assert.equal(at(worker.workerArgs({ prompt: 'p', tools: ['Read', 'Bash'] })), 'Read,Bash');
  assert.ok(!worker.workerArgs({ prompt: 'p' }).includes('--tools'));
});

test('resume uses --resume and not --session-id', () => {
  const args = worker.workerArgs({ prompt: 'p', sessionId: SESSION, resume: SESSION });
  assert.equal(args[args.indexOf('--resume') + 1], SESSION);
  assert.ok(!args.includes('--session-id'));
  assert.ok(worker.workerArgs({ prompt: 'p', sessionId: SESSION }).includes('--session-id'));
});

test('env: LEARN_APP_DISCORD_WEBHOOK and DISCORD_TOKEN removed; CLAUDE_CONFIG_DIR, BUG_FIX_STATE_DIR, LEARN_APP_BUILD_SLOTS=1 set; PATH and ANDROID_HOME kept', () => {
  const base = { PATH: '/bin', ANDROID_HOME: '/sdk', LEARN_APP_DISCORD_WEBHOOK: 'w', DISCORD_TOKEN: 't', LEARN_APP_BUILD_SLOTS: '9', CLAUDE_CONFIG_DIR: '/other' };
  const env = worker.workerEnv(base, '/dz');
  assert.equal(env.LEARN_APP_DISCORD_WEBHOOK, undefined);
  assert.equal(env.DISCORD_TOKEN, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, '/dz/claude');
  assert.equal(env.BUG_FIX_STATE_DIR, '/dz/bug-fix-state');
  assert.equal(env.LEARN_APP_BUILD_SLOTS, '1');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.ANDROID_HOME, '/sdk');
  assert.equal(base.DISCORD_TOKEN, 't');
});

test('env: background agents are never cut off and the state of an outer Claude session does not leak', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '600000', CLAUDE_CONFIG_DIR: '/other' };
  const env = worker.workerEnv(base, '/dz');
  const names = Object.keys(env).filter(n => n.startsWith('CLAUDE')).sort();
  assert.deepEqual(names, ['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'CLAUDE_CONFIG_DIR']);
  assert.equal(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, '0');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/dz/claude');
  assert.equal(base.CLAUDECODE, '1');
  const shared = worker.workerEnv({ ...base, DZ_CLAUDE_CONFIG: 'shared' }, '/dz');
  assert.deepEqual(Object.keys(shared).filter(n => n.startsWith('CLAUDE')), ['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']);
});

test('DZ_CLAUDE_CONFIG=shared removes CLAUDE_CONFIG_DIR instead of setting it', () => {
  const env = worker.workerEnv({ PATH: '/bin', DZ_CLAUDE_CONFIG: 'shared', CLAUDE_CONFIG_DIR: '/other' }, '/dz');
  assert.ok(!('CLAUDE_CONFIG_DIR' in env));
  assert.equal(env.BUG_FIX_STATE_DIR, '/dz/bug-fix-state');
});

test('startWorker writes the log with mode 600 in a 700 directory', async () => {
  const w = launch([{ print: 'hello' }, { sleep: 60000 }]);
  try {
    await waitFor(() => fs.readFileSync(w.logFile, 'utf8').includes('hello'));
    assert.equal(fs.statSync(w.logFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(w.logFile)).mode & 0o777, 0o700);
    assert.ok(w.pid > 0);
    assert.ok(w.pidStart);
    assert.equal(worker.processStart(w.pid), w.pidStart);
  } finally { killGroup(w.pid); }
});

test('startWorker throws when the binary does not exist and names the cwd and the cause', () => {
  const dir = tmp();
  assert.throws(
    () => worker.startWorker({ bin: path.join(dir, 'nope'), args: [], env: process.env, cwd: dir, logFile: path.join(dir, 'l') }),
    e => e.message.includes(dir) && e.message.includes('nope') && /not found|ENOENT/.test(e.message),
  );
  const missingCwd = path.join(dir, 'gone');
  assert.throws(
    () => worker.startWorker({ bin: process.execPath, args: [], env: process.env, cwd: missingCwd, logFile: path.join(dir, 'l') }),
    e => e.message.includes(missingCwd) && e.message.includes('ENOENT'),
  );
});

test('the worker survives the parent exiting and keeps writing its log', async () => {
  const dir = tmp();
  const logFile = path.join(dir, 'w.log');
  const script = JSON.stringify([{ print: 'A' }, { sleep: 700 }, { print: 'B' }, { sleep: 60000 }]);
  const parent = `
    const worker = require(${JSON.stringify(WORKER_SRC)});
    const w = worker.startWorker({ bin: process.execPath, args: [${JSON.stringify(FAKE)}], env: { ...process.env, FAKE_CLAUDE_SCRIPT: ${JSON.stringify(script)} }, cwd: ${JSON.stringify(dir)}, logFile: ${JSON.stringify(logFile)} });
    console.log(JSON.stringify(w));
  `;
  const out = spawnSync(process.execPath, ['-e', parent], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const { pid } = JSON.parse(out.stdout);
  try {
    assert.ok(alive(pid));
    await waitFor(() => fs.readFileSync(logFile, 'utf8').includes('B'));
    assert.ok(alive(pid));
  } finally { killGroup(pid); }
});

test('findWorkerBySession finds a live worker by its session id and returns null after it exits', async () => {
  const w = launch([{ sleep: 60000 }], { args: ['--session-id', SESSION, '--', 'x'] });
  try {
    const found = await waitFor(() => worker.findWorkerBySession(SESSION));
    assert.equal(found.pid, w.pid);
    assert.equal(found.pidStart, w.pidStart);
    assert.equal(worker.findWorkerBySession('00000000-0000-4000-8000-000000000000'), null);
    assert.equal(await worker.stopWorker(w.pid, w.pidStart, 2000), true);
    await waitFor(() => worker.findWorkerBySession(SESSION) === null);
  } finally { killGroup(w.pid); }
});

test('findWorkerBySession ignores a session id that only appears inside the prompt', async () => {
  const w = launch([{ sleep: 60000 }], { args: ['--', `--resume ${SESSION}`] });
  try {
    await sleep(150);
    assert.equal(worker.findWorkerBySession(SESSION), null);
  } finally { killGroup(w.pid); }
});

test('stopWorker kills a grandchild too', async () => {
  const pidFile = path.join(tmp(), 'gc');
  const w = launch([{ grandchild: pidFile }, { sleep: 60000 }]);
  try {
    const grandchild = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')));
    assert.ok(alive(grandchild));
    assert.equal(await worker.stopWorker(w.pid, w.pidStart, 3000), true);
    await waitFor(() => !alive(grandchild));
  } finally { killGroup(w.pid); }
});

test('stopWorker escalates to SIGKILL when the worker ignores SIGTERM', async () => {
  const dir = tmp();
  const stubborn = path.join(dir, 'stubborn.cjs');
  fs.writeFileSync(stubborn, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const w = worker.startWorker({ bin: process.execPath, args: [stubborn], env: process.env, cwd: dir, logFile: path.join(dir, 'l') });
  try {
    await sleep(200);
    const began = Date.now();
    assert.equal(await worker.stopWorker(w.pid, w.pidStart, 300), true);
    assert.ok(Date.now() - began >= 250);
    assert.ok(!alive(w.pid) || worker.processStart(w.pid) === null);
  } finally { killGroup(w.pid); }
});

test('stopWorker with a wrong pidStart sends no signal and returns false', async () => {
  const w = launch([{ sleep: 60000 }]);
  try {
    assert.equal(await worker.stopWorker(w.pid, 'Mon Jan  1 00:00:00 2001', 300), false);
    await sleep(100);
    assert.ok(alive(w.pid));
    assert.ok(worker.isSameProcess(w.pid, w.pidStart));
    assert.ok(!worker.isSameProcess(w.pid, 'Mon Jan  1 00:00:00 2001'));
  } finally { killGroup(w.pid); }
});

test('stopWorker refuses a process that is not its group leader and findWorkerBySession skips it', async () => {
  const child = require('node:child_process').spawn(process.execPath, [FAKE, '--session-id', SESSION, '--', 'x'], { stdio: 'ignore', env: { ...process.env, FAKE_CLAUDE_SCRIPT: JSON.stringify([{ sleep: 60000 }]) } });
  try {
    const start = await waitFor(() => worker.processStart(child.pid));
    assert.equal(await worker.stopWorker(child.pid, start, 300), false);
    assert.ok(alive(child.pid));
    assert.equal(worker.findWorkerBySession(SESSION), null);
    assert.equal(await worker.stopWorker(1, worker.processStart(1), 100), false);
  } finally { child.kill('SIGKILL'); }
});

test('findWorkerBySession with an empty or missing id returns null', () => {
  assert.equal(worker.findWorkerBySession(''), null);
  assert.equal(worker.findWorkerBySession(undefined), null);
});

test('huge command lines do not hide a live worker', async () => {
  const pad = 'y'.repeat(300000);
  const w = launch([{ sleep: 60000 }], { args: ['--pad', pad, '--pad2', pad, '--pad3', pad, '--session-id', SESSION, '--', 'x'] });
  try {
    const found = await waitFor(() => worker.findWorkerBySession(SESSION));
    assert.equal(found.pid, w.pid);
  } finally { killGroup(w.pid); }
});

test('a ps that cannot run throws instead of reporting no process', () => {
  const saved = worker.internals.psPath;
  worker.internals.psPath = '/nonexistent/ps';
  try {
    assert.throws(() => worker.processStart(process.pid));
    assert.throws(() => worker.findWorkerBySession(SESSION));
  } finally { worker.internals.psPath = saved; }
});

test('a missing pid is null, not an error', () => {
  assert.equal(worker.processStart(2147483000), null);
  assert.equal(worker.isSameProcess(2147483000, 'x'), false);
});

test('process start does not depend on the TZ of the caller', async () => {
  const w = launch([{ sleep: 60000 }]);
  const savedTz = process.env.TZ;
  try {
    const before = worker.processStart(w.pid);
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(worker.processStart(w.pid), before);
    assert.ok(worker.isSameProcess(w.pid, w.pidStart));
    process.env.TZ = 'America/Los_Angeles';
    assert.ok(worker.isSameProcess(w.pid, w.pidStart));
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    killGroup(w.pid);
  }
});

test('a leader that exits on SIGTERM while a grandchild ignores it → the grandchild gets SIGKILL', async () => {
  const pidFile = path.join(tmp(), 'gc');
  const w = launch([{ stubbornGrandchild: pidFile }, { sleep: 60000 }]);
  let grandchild;
  try {
    grandchild = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')));
    await sleep(150);
    assert.equal(await worker.stopWorker(w.pid, w.pidStart, 400), true);
    await waitFor(() => !alive(grandchild) || worker.processStart(grandchild) === null);
  } finally { killGroup(w.pid); }
});

test('a child in its own process group that ignores SIGTERM is killed with its own child; an unrelated process is untouched', async () => {
  const base = path.join(tmp(), 'tree');
  const bystander = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  const w = launch([{ stubbornTree: base }, { sleep: 60000 }]);
  let child;
  let grand;
  try {
    child = Number(await waitFor(() => fs.existsSync(base) && fs.readFileSync(base, 'utf8')));
    grand = Number(await waitFor(() => fs.existsSync(`${base}.grand`) && fs.readFileSync(`${base}.grand`, 'utf8')));
    await sleep(150);
    assert.equal(await worker.stopWorker(w.pid, w.pidStart, 400), true);
    await waitFor(() => !alive(child) || worker.processStart(child) === null);
    await waitFor(() => !alive(grand) || worker.processStart(grand) === null);
    assert.ok(alive(bystander.pid));
  } finally {
    for (const p of [child, grand]) if (p) { try { process.kill(p, 'SIGKILL'); } catch {} }
    killGroup(w.pid);
    bystander.kill('SIGKILL');
  }
});

test('a recorded descendant whose start time differs is not signalled', async () => {
  const other = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const start = await waitFor(() => worker.processStart(other.pid));
    worker.signalRecorded(new Map([[other.pid, 'Mon Jan  1 00:00:00 2001']]), 'SIGKILL');
    await sleep(100);
    assert.ok(alive(other.pid));
    worker.signalRecorded(new Map([[other.pid, start], [process.pid, worker.processStart(process.pid)], [1, 'x']]), 'SIGKILL');
    await waitFor(() => !alive(other.pid) || worker.processStart(other.pid) === null);
  } finally { other.kill('SIGKILL'); }
});

test('startWorker kills the just-spawned group when reading its start time fails', async () => {
  const dir = tmp();
  const saved = worker.internals.psPath;
  worker.internals.psPath = '/nonexistent/ps';
  try {
    assert.throws(() => worker.startWorker({ bin: process.execPath, args: [FAKE, '--session-id', SESSION, '--', 'x'], env: { ...process.env, FAKE_CLAUDE_SCRIPT: JSON.stringify([{ sleep: 60000 }]) }, cwd: dir, logFile: path.join(dir, 'l') }));
  } finally { worker.internals.psPath = saved; }
  await sleep(300);
  const leftover = worker.findWorkerBySession(SESSION);
  if (leftover) killGroup(leftover.pid);
  assert.equal(leftover, null);
});

const psCommands = () => require('node:child_process').execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
const killMarked = marker => {
  for (const row of psCommands()) {
    const m = row.trim().match(/^(\d+)\s+(.*)$/);
    if (m && m[2].includes(marker) && Number(m[1]) !== process.pid) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch {} }
  }
};

test('descendants spawned after the leader died are killed too', async () => {
  const marker = 'sleep 4711';
  const pidFile = path.join(tmp(), 'sh');
  const w = launch([{ detachedShell: `trap '' TERM; sleep 1; sleep 1; ${marker}`, pidFile }, { sleep: 60000 }]);
  try {
    await waitFor(() => fs.existsSync(pidFile));
    assert.equal(await worker.stopWorker(w.pid, w.pidStart, 3000), true);
    assert.ok(!psCommands().some(r => r.includes(marker) && !r.includes('/bin/ps')));
  } finally {
    killMarked(marker);
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    killGroup(w.pid);
  }
});

test('graceMs that is not a finite number >= 0 throws', async () => {
  for (const bad of [-1, NaN, Infinity, undefined, '5']) {
    await assert.rejects(() => worker.stopWorker(process.pid, 'x', bad), TypeError);
  }
});

test('a ps failure during grace does not stop the kill phase', async () => {
  const dir = tmp();
  const stubborn = path.join(dir, 'stubborn.cjs');
  fs.writeFileSync(stubborn, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const w = worker.startWorker({ bin: process.execPath, args: [stubborn], env: process.env, cwd: dir, logFile: path.join(dir, 'l') });
  const real = worker.internals.psPath;
  const wrapper = path.join(dir, 'ps-flaky');
  const counter = path.join(dir, 'count');
  fs.writeFileSync(wrapper, `#!/bin/sh\nn=$(cat ${counter} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${counter}\nif [ $n -ge 2 ] && [ $n -le 4 ]; then exit 3; fi\nexec /bin/ps "$@"\n`, { mode: 0o755 });
  try {
    await sleep(200);
    worker.internals.psPath = wrapper;
    assert.equal(await worker.stopWorker(w.pid, w.pidStart, 300), true);
    worker.internals.psPath = real;
    assert.ok(!alive(w.pid) || worker.processStart(w.pid) === null);
  } finally { worker.internals.psPath = real; killGroup(w.pid); }
});

test('an empty process table throws instead of reporting no process, and a hanging ps is cut off', () => {
  const saved = { ...worker.internals };
  const script = text => {
    const file = path.join(tmp(), 'ps');
    fs.writeFileSync(file, `#!/bin/sh\n${text}\n`, { mode: 0o755 });
    return file;
  };
  assert.equal(worker.internals.timeoutMs, 10000);
  try {
    for (const text of ['exit 0', 'echo; echo']) {
      worker.internals.psPath = script(text);
      assert.throws(() => worker.findWorkerBySession(SESSION), /rỗng/);
      assert.throws(() => worker.signalRecorded(new Map(), 'SIGTERM'), /rỗng/);
    }
    worker.internals.psPath = script("trap '' TERM; exec sleep 5");
    worker.internals.timeoutMs = 200;
    const began = Date.now();
    assert.throws(() => worker.processStart(process.pid), /ETIMEDOUT/);
    assert.throws(() => worker.findWorkerBySession(SESSION), /ETIMEDOUT/);
    assert.ok(Date.now() - began < 3000);
  } finally { Object.assign(worker.internals, saved); }
});

test('env: API keys and GitHub tokens never reach a worker', () => {
  const names = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
  const base = { PATH: '/bin', ...Object.fromEntries(names.map(n => [n, 'x'])) };
  for (const extra of [{}, { DZ_CLAUDE_CONFIG: 'shared' }]) {
    const env = worker.workerEnv({ ...base, ...extra }, '/dz');
    for (const name of names) assert.ok(!(name in env), name);
    assert.equal(env.PATH, '/bin');
  }
  assert.equal(base.GH_TOKEN, 'x');
});
