const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const table = require('./process-table.cjs');
const { workerEnv, applyEnv } = require('./worker-env.cjs');
const { findBin } = require('./find-bin.cjs');

const POLL_MS = 50;
const KILL_WINDOW_MS = 2000;
const PERMISSION_MODES = ['default', 'acceptEdits', 'dontAsk'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function workerArgs({ prompt, sessionId, resume, model, tools, allowedTools, disallowedTools, mcpConfig, extraMcp, pluginDirs, jsonSchema, permissionMode }) {
  if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode)) throw new Error(`permissionMode không được phép: ${permissionMode}`);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--setting-sources', 'project'];
  if (model) args.push('--model', model);
  if (resume) args.push('--resume', resume);
  else if (sessionId) args.push('--session-id', sessionId);
  if (tools) args.push('--tools', tools.join(','));
  if (allowedTools && allowedTools.length) args.push('--allowedTools', ...allowedTools);
  if (disallowedTools && disallowedTools.length) args.push('--disallowedTools', ...disallowedTools);
  const mcpConfigs = [mcpConfig, ...(extraMcp || [])].filter(Boolean);
  if (mcpConfigs.length) args.push('--mcp-config', ...mcpConfigs);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (jsonSchema) args.push('--json-schema', typeof jsonSchema === 'string' ? jsonSchema : JSON.stringify(jsonSchema));
  for (const dir of pluginDirs || []) args.push('--plugin-dir', dir);
  args.push('--', prompt);
  return args;
}

function spawnFailure(bin, cwd) {
  const fail = cause => new Error(`cannot start worker ${bin}: ${cause}`);
  try {
    if (!fs.statSync(cwd).isDirectory()) return fail(`cwd is not a directory: ${cwd}`);
    fs.accessSync(cwd, fs.constants.X_OK);
  } catch (error) {
    return fail(`cwd ${cwd}: ${error.code || error.message}`);
  }
  return Object.assign(fail(`ENOENT: ${bin} not found or not executable (cwd ${cwd})`), { machineWide: true });
}

function wrapped({ bin, args, env, cwd, sandbox }) {
  if (!sandbox) return [bin, args];
  const program = findBin(bin, { searchPath: (env ?? process.env).PATH, cwd });
  if (!program) throw spawnFailure(bin, cwd);
  return [sandbox.bin, ['-f', sandbox.profile, program, ...args]];
}

function spawnOrCleanUp({ bin, args, env, cwd, logFile, fd, sandbox }) {
  try {
    const child = spawn(...wrapped({ bin, args, env, cwd, sandbox }), { env, cwd, detached: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => {});
    if (!child.pid) throw spawnFailure(bin, cwd);
    return child;
  } catch (error) {
    if (fs.fstatSync(fd).size === 0) fs.rmSync(logFile, { force: true });
    throw error;
  }
}

function startWorker({ bin = 'claude', args, env, cwd, logFile, sandbox }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    const child = spawnOrCleanUp({ bin, args, env, cwd, logFile, fd, sandbox });
    child.unref();
    try {
      return { pid: child.pid, pidStart: table.processStart(child.pid) };
    } catch (error) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

function leaderState(rows, pid, pidStart) {
  const row = rows.find(r => r.pid === pid);
  if (!row || row.zombie) return 'gone';
  return row.start === pidStart ? 'same' : 'reused';
}

function expand(rows, pid, pidStart, recorded) {
  const roots = table.liveRecorded(rows, recorded).map(([child]) => child);
  if (leaderState(rows, pid, pidStart) === 'same') roots.push(pid);
  const fresh = new Map();
  for (const root of roots) {
    for (const [child, start] of table.descendantsOf(rows, root)) {
      if (!recorded.has(child)) fresh.set(child, start);
    }
  }
  for (const [child, start] of fresh) recorded.set(child, start);
  return fresh;
}

function groupMembers(rows, pid, pidStart) {
  if (leaderState(rows, pid, pidStart) === 'reused') return false;
  return rows.some(r => r.pgid === pid && !r.zombie);
}

function settled(rows, pid, pidStart, recorded) {
  return !groupMembers(rows, pid, pidStart) && table.liveRecorded(rows, recorded).length === 0;
}

function tryTable(state) {
  try {
    const rows = table.readTable();
    state.error = null;
    return rows;
  } catch (error) {
    state.error = error;
    return null;
  }
}

async function stopWorker(pid, pidStart, graceMs) {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new TypeError('graceMs must be a finite number >= 0');
  if (!(pid > 1) || pid === process.pid || !pidStart) return false;
  const first = table.readTable();
  const row = first.find(r => r.pid === pid);
  if (!row || row.zombie || row.start !== pidStart || row.pgid !== pid) return false;
  const recorded = new Map();
  expand(first, pid, pidStart, recorded);
  signalGroup(pid, 'SIGTERM');
  table.signalRecorded(recorded, 'SIGTERM', first);
  const state = { error: null };
  const graceEnd = Date.now() + graceMs;
  while (Date.now() < graceEnd) {
    await sleep(POLL_MS);
    const rows = tryTable(state);
    if (!rows) continue;
    const fresh = expand(rows, pid, pidStart, recorded);
    if (settled(rows, pid, pidStart, recorded)) return true;
    table.signalRecorded(fresh, 'SIGTERM', rows);
  }
  const killEnd = Date.now() + KILL_WINDOW_MS;
  for (;;) {
    const rows = tryTable(state);
    if (rows) {
      expand(rows, pid, pidStart, recorded);
      if (settled(rows, pid, pidStart, recorded)) return true;
      if (groupMembers(rows, pid, pidStart)) signalGroup(pid, 'SIGKILL');
      table.signalRecorded(recorded, 'SIGKILL', rows);
    }
    if (Date.now() >= killEnd) break;
    await sleep(POLL_MS);
  }
  if (state.error) throw state.error;
  return false;
}

module.exports = {
  workerArgs, workerEnv, applyEnv, startWorker, stopWorker,
  processStart: table.processStart,
  isSameProcess: table.isSameProcess,
  findWorkerBySession: table.findWorkerBySession,
  signalRecorded: table.signalRecorded,
  internals: table.internals,
};
