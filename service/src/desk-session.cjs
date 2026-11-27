const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const kv = require('./kv.cjs');
const table = require('./process-table.cjs');
const { stopWorker } = require('./worker.cjs');
const { runCommand } = require('./doctor-exec.cjs');
const { prepare, deskPaths, deskEnv, deskPathDirs, PLUGIN } = require('./desk-config.cjs');

const SESSION = 'dz-desk';
const KEY = 'desk:session';
const GRACE_MS = 10000;
const GONE_TRIES = 20;
const GONE_WAIT_MS = 100;
const PROMPT = 'Phiên mới. Gọi tool pending của dz rồi xử lý từng tin theo CLAUDE.md.';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findBin(name, env) {
  const candidates = path.isAbsolute(name) ? [name] : deskPathDirs(env).map(dir => path.join(dir, name));
  return candidates.find(file => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

function claudeArgs(paths, sessionId) {
  return [
    '--channels', `plugin:${PLUGIN}`,
    '--permission-mode', 'dontAsk',
    '--tools', '',
    '--setting-sources', 'project',
    '--settings', paths.settings,
    '--mcp-config', paths.mcp,
    '--append-system-prompt-file', paths.guide,
    '--disable-slash-commands',
    '--no-chrome',
    '--session-id', sessionId,
    '--', PROMPT,
  ];
}

function tmuxStartArgs({ paths, env, claude, sessionId }) {
  return [
    '-L', SESSION, '-f', '/dev/null',
    'new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', SESSION, '-x', '200', '-y', '50', '-c', paths.dir,
    '--', '/usr/bin/env', '-i', ...Object.entries(env).map(([name, value]) => `${name}=${value}`), claude, ...claudeArgs(paths, sessionId),
  ];
}

function createDeskSession({ db, dzHome, env = process.env, claudeBin = 'claude', tmuxBin = 'tmux', exec = runCommand, graceMs = GRACE_MS }) {
  const paths = deskPaths(dzHome);
  const childEnv = deskEnv(env, dzHome);
  const tmux = args => {
    const bin = findBin(tmuxBin, env);
    if (!bin) throw new Error('không tìm thấy tmux');
    return exec(bin, args, childEnv);
  };
  const exists = () => tmux(['-L', SESSION, 'has-session', '-t', `=${SESSION}`]).ok;

  function current(now) {
    const row = kv.get(db, KEY);
    if (!row) return null;
    if (row.pid === null) {
      const found = table.findWorkerBySession(row.sessionId);
      if (found) {
        Object.assign(row, found);
        kv.set(db, KEY, row, now);
      }
    }
    return { ...row, alive: row.pid !== null && table.isSameProcess(row.pid, row.pidStart) };
  }

  async function waitGone() {
    for (let i = 0; i < GONE_TRIES; i += 1) {
      if (!exists()) return true;
      await sleep(GONE_WAIT_MS);
    }
    return false;
  }

  async function start(projects, now) {
    const running = current(now);
    if (running?.alive) return running;
    prepare(dzHome, projects);
    const claude = findBin(claudeBin, env);
    if (!claude) throw new Error('không tìm thấy claude');
    if (!(await waitGone())) throw new Error(`đã có phiên tmux ${SESSION} không phải do service mở`);
    const row = { sessionId: crypto.randomUUID(), pid: null, pidStart: null, startedAt: now };
    kv.set(db, KEY, row, now);
    const out = tmux(tmuxStartArgs({ paths, env: childEnv, claude, sessionId: row.sessionId }));
    if (!out.ok) throw new Error('tmux không mở được phiên');
    const pid = Number(out.stdout.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('tmux không trả về pid');
    const pidStart = table.processStart(pid);
    if (!pidStart) throw new Error('phiên thoát ngay khi mở');
    kv.set(db, KEY, { ...row, pid, pidStart }, now);
    return { ...row, pid, pidStart, alive: true };
  }

  async function stop(now) {
    const running = current(now);
    if (running?.alive && !(await stopWorker(running.pid, running.pidStart, graceMs))) {
      if (table.isSameProcess(running.pid, running.pidStart)) throw new Error(`phiên điều phối (pid ${running.pid}) chưa dừng`);
    }
    kv.del(db, KEY);
    return running?.alive === true;
  }

  return { start, stop, current };
}

module.exports = { createDeskSession, claudeArgs, tmuxStartArgs, findBin, SESSION, PROMPT };
