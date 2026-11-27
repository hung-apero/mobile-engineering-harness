const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createContext } = require('../src/context.cjs');
const jobs = require('../src/jobs.cjs');
const { yamlFor } = require('./projects-fixtures.cjs');

const DZ = path.join(__dirname, '..', 'bin', 'dz.cjs');
const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.cjs');
const RULES = path.join(__dirname, '..', 'rules', 'default.yaml');
const NOW = Date.parse('2026-11-25T20:00:00+07:00');
const MIN = 60000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const line = event => ({ print: JSON.stringify(event) });
const OK = { type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0.1, num_turns: 1, permission_denials: [] };

async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error('timeout');
}

function writeScript(file, text) {
  fs.writeFileSync(file, `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  return file;
}

function makeHome(t, keys = ['ABC1'], script = [{ sleep: 60000 }]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-svc-')));
  const dzHome = path.join(root, 'home');
  const rulesDir = path.join(root, 'rules');
  fs.mkdirSync(rulesDir);
  fs.writeFileSync(path.join(rulesDir, 'default.yaml'), fs.readFileSync(RULES, 'utf8').replace('min_free_gb: 15', 'min_free_gb: 0'));
  const bin = writeScript(path.join(root, 'fake-claude'), `exec "${process.execPath}" "${FAKE}" "$@"`);
  const env = { ...process.env, DZ_HOME: dzHome, DZ_RULES_DIR: rulesDir, DZ_CLAUDE_BIN: bin, DZ_WEB_PORT: '0', FAKE_CLAUDE_SCRIPT: JSON.stringify(script) };
  const h = { root, dzHome, rulesDir, env, open: [], procs: [] };
  h.context = (extra = {}) => {
    const ctx = Object.assign(createContext(env), { freeGb: () => 500, send: async () => { throw new Error('no network'); } }, extra);
    ctx.deps = { ...ctx.deps, bootTime: () => 0 };
    h.open.push(ctx);
    return ctx;
  };
  h.project = (key, overrides) => fs.writeFileSync(path.join(dzHome, 'projects', `${key}.yaml`), yamlFor(key, dzHome, overrides));
  h.webhook = (key, text = 'https://discord.com/api/webhooks/1/secret') => fs.writeFileSync(path.join(dzHome, 'secrets', `${key}.discord-webhook`), text, { mode: 0o600 });
  h.logs = event => {
    const file = path.join(dzHome, 'logs', 'service.jsonl');
    const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    return event ? rows.filter(r => r.event === event) : rows;
  };
  h.dz = (...args) => spawnSync(process.execPath, [DZ, ...args], { env, encoding: 'utf8' });
  h.run = () => {
    const child = spawn(process.execPath, [DZ, 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    h.procs.push(child);
    child.output = '';
    child.stdout.on('data', d => { child.output += d; });
    child.stderr.on('data', d => { child.output += d; });
    child.done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    return child;
  };
  t.after(async () => {
    for (const child of h.procs) child.kill('SIGKILL');
    await Promise.all(h.procs.map(child => child.done));
    const ctx = createContext(env);
    for (const job of jobs.listJobs(ctx.db)) {
      const found = job.sessionId && ctx.deps.findWorkerBySession(job.sessionId);
      for (const pid of [found?.pid]) if (pid) try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
    ctx.db.close();
    for (const opened of h.open) try { opened.db.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  createContext(env).db.close();
  for (const key of keys) h.project(key);
  return h;
}

function add(ctx, project, key, extra = {}) {
  return jobs.enqueue(ctx.db, { project, kind: 'probe', key, priority: 1, slots: 1, payload: {}, ...extra }, NOW).id;
}

function fakeWorkers(ctx, failing = () => null) {
  const calls = [];
  let pid = 900000;
  const alive = new Map();
  ctx.startWorker = options => {
    calls.push(options);
    const error = failing(options);
    if (error) throw error;
    alive.set(++pid, `s${pid}`);
    return { pid, pidStart: `s${pid}` };
  };
  ctx.deps = { ...ctx.deps, modifiedAt: () => Infinity, isSameProcess: (p, s) => alive.get(p) === s, findWorkerBySession: () => null };
  return { calls, alive };
}

module.exports = { makeHome, add, fakeWorkers, waitFor, sleep, line, writeScript, OK, NOW, MIN, DZ };
