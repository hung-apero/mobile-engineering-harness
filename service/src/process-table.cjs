const { execFileSync } = require('node:child_process');

const internals = { psPath: '/bin/ps', timeoutMs: 10000 };

function ps(args, { single = false } = {}) {
  let out;
  try {
    out = execFileSync(internals.psPath, args, {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: internals.timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (error) {
    if (single && error.status === 1 && !error.code) return '';
    throw error;
  }
  if (!single && out.trim() === '') throw new Error('ps trả về bảng tiến trình rỗng');
  return out;
}

function processInfo(pid) {
  const out = ps(['-o', 'pgid=,stat=,lstart=', '-p', String(pid)], { single: true }).trim();
  const match = out.match(/^(\d+)\s+(\S+)\s+(.+)$/);
  if (!match || match[2].startsWith('Z')) return null;
  return { pgid: Number(match[1]), start: match[3].trim() };
}

function processStart(pid) {
  const info = processInfo(pid);
  return info ? info.start : null;
}

function isSameProcess(pid, pidStart) {
  if (!pidStart) return false;
  return processStart(pid) === pidStart;
}

function findWorkerBySession(sessionId) {
  if (!sessionId) return null;
  for (const row of ps(['-axo', 'pid=,pgid=,command=']).split('\n')) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || Number(match[2]) !== pid) continue;
    const tokens = match[3].split(/\s+/);
    const end = tokens.indexOf('--');
    const flags = end === -1 ? tokens : tokens.slice(0, end);
    const hit = flags.some((t, i) => (t === '--session-id' || t === '--resume') && flags[i + 1] === sessionId);
    if (!hit) continue;
    const pidStart = processStart(pid);
    if (pidStart) return { pid, pidStart };
  }
  return null;
}

function readTable() {
  const rows = [];
  for (const row of ps(['-axo', 'pid=,ppid=,pgid=,stat=,lstart=']).split('\n')) {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), zombie: match[4].startsWith('Z'), start: match[5].trim() });
  }
  return rows;
}

function descendantsOf(rows, root) {
  const found = new Map();
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.ppid !== parent || found.has(row.pid) || row.zombie) continue;
      if (row.pid > 1 && row.pid !== process.pid) found.set(row.pid, row.start);
      queue.push(row.pid);
    }
  }
  return found;
}

function liveRecorded(rows, recorded) {
  return [...recorded].filter(([pid, start]) => rows.some(r => r.pid === pid && r.start === start && !r.zombie));
}

function signalRecorded(recorded, signal, rows = readTable()) {
  for (const [pid] of liveRecorded(rows, recorded)) {
    if (pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

module.exports = { internals, processInfo, processStart, isSameProcess, findWorkerBySession, readTable, descendantsOf, liveRecorded, signalRecorded };
