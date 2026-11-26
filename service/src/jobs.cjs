const crypto = require('node:crypto');
const { toJob } = require('./job-row.cjs');
const { grant } = require('./slots.cjs');

const OPEN = ['queued', 'starting', 'running', 'parked'];
const OPEN_SQL = OPEN.map(s => `'${s}'`).join(', ');
const KINDS = ['probe', 'bug', 'feature', 'review', 'gate', 'build', 'spec', 'explain', 'e2e', 'uidiff'];

function getJob(db, id) {
  return toJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
}

function listJobs(db, { states, project } = {}) {
  const where = [];
  const args = [];
  if (states) {
    where.push(`state IN (${states.map(() => '?').join(', ')})`);
    args.push(...states);
  }
  if (project !== undefined) {
    where.push('project = ?');
    args.push(project);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM jobs ${clause} ORDER BY id`).all(...args).map(toJob);
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function openJobId(db, { project, kind, key }) {
  const open = db.prepare(
    `SELECT id FROM jobs WHERE project = ? AND kind = ? AND key = ? AND state IN (${OPEN_SQL})`,
  ).get(project, kind, key);
  return open ? open.id : null;
}

function enqueue(db, { project, kind, key, priority, slots, payload }, now) {
  if (!KINDS.includes(kind)) throw new Error(`kind không hợp lệ: ${kind}`);
  return inTransaction(db, () => {
    const insert = db.prepare(
      `INSERT INTO jobs (project, kind, key, priority, slots, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, kind, key) WHERE state IN (${OPEN_SQL}) DO NOTHING`,
    ).run(project, kind, key, priority, slots, now, JSON.stringify(payload ?? {}));
    if (insert.changes === 1) return { id: Number(insert.lastInsertRowid), created: true };
    return { id: openJobId(db, { project, kind, key }), created: false };
  });
}

function claimNext(db, { projects, limits, now, kinds }) {
  return inTransaction(db, () => {
    const queued = db.prepare(
      `SELECT j.* FROM jobs j WHERE j.state = 'queued'
       ORDER BY j.priority,
         COALESCE((SELECT MAX(started_at) FROM jobs WHERE project = j.project), -1),
         j.id`,
    ).all().map(toJob);
    const running = listJobs(db, { states: ['starting', 'running'] });
    for (const job of queued) {
      if (!projects.has(job.project) || (kinds && !kinds.includes(job.kind))) continue;
      const granted = grant({ job, running, limits, now });
      if (granted <= 0) continue;
      db.prepare(
        `UPDATE jobs SET state = 'starting', slots_granted = ?, started_at = ?, attempt = attempt + 1,
           session_id = COALESCE(session_id, ?), pid = NULL, pid_start = NULL,
           log_file = NULL, log_offset = 0, last_event_at = NULL WHERE id = ?`,
      ).run(granted, now, crypto.randomUUID(), job.id);
      return getJob(db, job.id);
    }
    return null;
  });
}

const COLUMNS = {
  state: 'state', slotsGranted: 'slots_granted', resume: 'resume', resumes: 'resumes',
  sessionId: 'session_id', pid: 'pid', pidStart: 'pid_start', logFile: 'log_file',
  logOffset: 'log_offset', lastEventAt: 'last_event_at', finishedAt: 'finished_at',
  result: 'result', parkReason: 'park_reason',
};

function transition(db, id, from, to, changes = {}) {
  return inTransaction(db, () => {
    const job = getJob(db, id);
    if (!job) throw new Error(`không có việc ${id}`);
    if (!from.includes(job.state)) throw new Error(`việc ${id}: không thể chuyển ${job.state} → ${to}`);
    const extra = typeof changes === 'function' ? changes(job) : changes;
    if (extra === null) return null;
    const fields = { state: to, ...extra };
    const names = Object.keys(fields);
    const sets = names.map(name => `${COLUMNS[name]} = ?`).join(', ');
    const values = names.map(name => (typeof fields[name] === 'boolean' ? Number(fields[name]) : fields[name]));
    db.prepare(`UPDATE jobs SET ${sets} WHERE id = ?`).run(...values, id);
    return getJob(db, id);
  });
}

function markRunning(db, id, { pid, pidStart, sessionId, logFile }, now) {
  return transition(db, id, ['starting'], 'running', { pid, pidStart, sessionId, logFile, lastEventAt: now });
}

function finish(db, id, state, result, now) {
  if (state !== 'done' && state !== 'failed') throw new Error(`trạng thái kết thúc không hợp lệ: ${state}`);
  return transition(db, id, ['starting', 'running'], state, { result: JSON.stringify(result ?? null), finishedAt: now });
}

function park(db, id, reason, now) {
  return transition(db, id, ['starting', 'running'], 'parked', { parkReason: reason, lastEventAt: now });
}

function retry(db, id, now) {
  return transition(db, id, ['parked', 'failed'], 'queued', job => {
    const open = openJobId(db, job);
    if (open !== null && open !== job.id) throw new Error(`việc #${open} cùng khoá đang mở, không thể chạy lại việc #${id}`);
    return {
      sessionId: null, resume: false, resumes: 0, pid: null, pidStart: null, finishedAt: null, result: null,
      logOffset: 0, lastEventAt: null, parkReason: null, slotsGranted: 0,
    };
  });
}

function requeue(db, id, now, { keepSession, ran = false }) {
  return transition(db, id, ['starting', 'running'], 'queued', job => {
    const resume = Boolean(keepSession && (ran || job.pid != null || job.resume));
    return resume ? { slotsGranted: 0, resume } : { slotsGranted: 0, resume, sessionId: null };
  });
}

function requeueForResume(db, id, now, { max, keepSession = true }) {
  return transition(db, id, ['starting', 'running'], 'queued', job => {
    if (job.resumes >= max) return null;
    const changes = { slotsGranted: 0, resume: keepSession, resumes: job.resumes + 1 };
    return keepSession ? changes : { ...changes, sessionId: null };
  });
}

function updateProgress(db, id, { logOffset, lastEventAt }) {
  db.prepare("UPDATE jobs SET log_offset = ?, last_event_at = ? WHERE id = ? AND state = 'running'").run(logOffset, lastEventAt, id);
  return getJob(db, id);
}

module.exports = {
  enqueue, claimNext, markRunning, finish, park, retry, requeue, requeueForResume,
  getJob, listJobs, updateProgress,
};
