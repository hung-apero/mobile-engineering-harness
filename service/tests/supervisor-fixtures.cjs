const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');
const jobs = require('../src/jobs.cjs');
const { readEvents, summarize } = require('../src/stream-reader.cjs');

const MIN = 60000;
const NOW = Date.parse('2026-11-25T20:00:00+07:00');
const limits = { code_agents_working: 8, code_agents_off: 8, reserved_for_bug: 0, build: 1, bugs_per_project: 8 };
const rulesFor = () => ({ version: 'v', rules: { X02: { silent_minutes: 30, max_resumes: 1 } }, limits });

const ev = {
  text: n => ({ type: 'assistant', parent_tool_use_id: null, n }),
  tasks: (...ids) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ids.map(task_id => ({ task_id })) }),
  ok: (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'xong', total_cost_usd: 0.5, num_turns: 3, permission_denials: [], ...extra }),
  bad: (extra = {}) => ({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['hỏng'], permission_denials: [], ...extra }),
  quota: (status, utilization = 0.5) => ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1796018400, unifiedWindows: { seven_day: { utilization, resetsAt: 1796018400, status } } } }),
};

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-sup-'));
  const file = path.join(dir, 'dz.db');
  const alive = new Map();
  const sessions = new Map();
  const calls = { stop: [], read: [] };
  const w = {
    dir, file, alive, sessions, calls, db: openDb(file), nextPid: 4000,
    deps: {
      readEvents: (log, offset) => { calls.read.push(offset); return readEvents(log, offset); },
      summarize,
      modifiedAt: () => Infinity,
      bootTime: () => 0,
      isSameProcess: (pid, start) => alive.get(pid) === start,
      findWorkerBySession: session => sessions.get(session) ?? null,
      stopWorker: async (pid, start, grace) => { calls.stop.push([pid, start, grace]); alive.delete(pid); return true; },
      logFileFor: job => path.join(dir, 'logs', `${job.id}-${job.attempt}.jsonl`),
    },
    reopen() { w.db.close(); w.db = openDb(file); },
    add(key, project = 'a') {
      return jobs.enqueue(w.db, { project, kind: 'feature', key, priority: 1, slots: 1, payload: {} }, NOW).id;
    },
    claim(now = NOW) { return jobs.claimNext(w.db, { projects: new Set(['a', 'b']), limits, now }); },
    log(id, ...events) {
      const logFile = w.deps.logFileFor(jobs.getJob(w.db, id));
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, events.map(e => `${JSON.stringify(e)}\n`).join(''));
    },
    raw(id, text) {
      w.log(id);
      fs.appendFileSync(w.deps.logFileFor(jobs.getJob(w.db, id)), text);
    },
    spawn(job) {
      const started = { pid: w.nextPid++, pidStart: `start-${w.nextPid}` };
      alive.set(started.pid, started.pidStart);
      sessions.set(job.sessionId, started);
      return started;
    },
    run(key, project = 'a', now = NOW) {
      w.add(key, project);
      const job = w.claim(now);
      const started = w.spawn(job);
      return jobs.markRunning(w.db, job.id, { ...started, sessionId: job.sessionId, logFile: w.deps.logFileFor(job) }, now);
    },
    start() {
      const job = w.claim();
      return jobs.markRunning(w.db, job.id, { ...w.spawn(job), sessionId: job.sessionId, logFile: w.deps.logFileFor(job) }, NOW);
    },
    die(job) { alive.delete(job.pid); sessions.delete(job.sessionId); },
    job(id) { return jobs.getJob(w.db, id); },
  };
  return w;
}

module.exports = { world, ev, rulesFor, limits, NOW, MIN };
