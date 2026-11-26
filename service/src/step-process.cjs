const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { stopWorker, processStart } = require('./worker.cjs');
const { applyEnv } = require('./worker-env.cjs');
const { redact } = require('./redact.cjs');

const LOG_MAX = 20 * 1024 * 1024;
const RAW_TAIL = 32000;
const TAIL_MAX = 4000;
const GRACE_MS = 3000;
const DRAIN_MS = 500;
const SIGNAL_WAIT_MS = 1000;
const { O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function openStepLog(file) {
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
  fs.fchmodSync(fd, 0o600);
  let size = 0;
  let tail = Buffer.alloc(0);
  return {
    reset: () => { tail = Buffer.alloc(0); },
    write(chunk) {
      tail = Buffer.concat([tail, chunk]).subarray(-RAW_TAIL);
      const part = chunk.subarray(0, LOG_MAX - size);
      try {
        size += fs.writeSync(fd, part);
      } catch {}
    },
    tail: () => redact(tail.toString('utf8')).slice(-TAIL_MAX).toWellFormed(),
    close: () => fs.closeSync(fd),
  };
}

const ended = child => !child.pid || child.exitCode !== null || child.signalCode !== null;

async function stopTree(child, graceMs = GRACE_MS) {
  if (ended(child)) return true;
  try {
    const start = processStart(child.pid);
    if (!start || await stopWorker(child.pid, start, graceMs)) return true;
  } catch {}
  if (ended(child)) return true;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
  return false;
}

function spawnStep(step) {
  try {
    const [bin, ...args] = step.argv;
    return spawn(bin, args, { cwd: step.cwd, env: applyEnv(process.env, step.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return { error };
  }
}

function watch(child, step) {
  const exit = new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: null, signal: null, error }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  let timer;
  let killing = null;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      killing = stopTree(child);
      killing.then(() => resolve({ exitCode: null, signal: null }));
    }, step.timeoutMs);
  });
  return Promise.race([exit, timeout]).then(async end => {
    clearTimeout(timer);
    if (!killing) return { ...end, timedOut: false, stopped: true };
    const stopped = await killing;
    return { ...end, timedOut: true, stopped };
  });
}

async function runAttempt(step, log, state, onSpawn) {
  log.reset();
  const child = spawnStep(step);
  if (child.error) {
    log.write(Buffer.from(`${child.error.message}\n`));
    return { ok: false, exitCode: null, signal: null, timedOut: false, stopped: true };
  }
  state.child = child;
  if (child.pid) onSpawn?.(child.pid);
  const streams = [child.stdout, child.stderr].filter(Boolean);
  for (const stream of streams) stream.on('data', log.write).on('error', () => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  const end = await watch(child, step);
  await Promise.race([closed, sleep(DRAIN_MS)]);
  for (const stream of streams) stream.destroy();
  if (end.error) log.write(Buffer.from(`${end.error.message}\n`));
  if (!end.timedOut && (end.signal || end.exitCode > 128)) await sleep(SIGNAL_WAIT_MS);
  if (state.stopping) await new Promise(() => {});
  state.child = null;
  const { exitCode, signal, timedOut, stopped } = end;
  return { ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut, stopped };
}

module.exports = { openStepLog, runAttempt, stopTree };
