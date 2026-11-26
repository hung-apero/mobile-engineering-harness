const fs = require('node:fs');

function freeGb(path) {
  const stat = fs.statfsSync(path);
  return (stat.bavail * stat.bsize) / 1e9;
}

function intake({ quota, freeGb: free, rules, now }) {
  if (quota) {
    const until = Number.isFinite(quota.resetsAt) ? quota.resetsAt * 1000 : undefined;
    const stopped = quota.status === 'rejected' || quota.utilization >= rules.X01.stop_new_at;
    if (stopped && (until === undefined || now < until)) {
      return until === undefined ? { open: false, code: 'X01' } : { open: false, code: 'X01', until };
    }
  }
  if (typeof free === 'number' && free < rules.X05.min_free_gb) return { open: false, code: 'X05' };
  return { open: true };
}

function setProjectState(db, project, { paused, resumedAt } = {}) {
  db.prepare(
    `INSERT INTO project_state (project, paused, resumed_at) VALUES (?, COALESCE(?, 0), ?)
     ON CONFLICT (project) DO UPDATE SET
       paused = COALESCE(?, paused), resumed_at = COALESCE(?, resumed_at)`,
  ).run(
    project,
    paused === undefined ? null : Number(paused),
    resumedAt ?? null,
    paused === undefined ? null : Number(paused),
    resumedAt ?? null,
  );
}

function getProjectState(db, project) {
  const row = db.prepare('SELECT paused, resumed_at FROM project_state WHERE project = ?').get(project);
  return { paused: row?.paused === 1, resumedAt: row?.resumed_at ?? null };
}

function isPaused(db, project) {
  return getProjectState(db, project).paused;
}

function projectBlocked(db, project, rules) {
  const { resumedAt } = getProjectState(db, project);
  const rows = db
    .prepare(
      `SELECT state FROM jobs
       WHERE project = ? AND kind IN ('probe', 'bug', 'feature', 'review') AND state IN ('done', 'failed') AND finished_at IS NOT NULL AND finished_at >= ?
       ORDER BY finished_at DESC, id DESC`,
    )
    .all(project, resumedAt ?? 0);
  let streak = 0;
  for (const row of rows) {
    if (row.state !== 'failed') break;
    streak++;
  }
  return streak >= rules.X07.max_consecutive_failures;
}

module.exports = { freeGb, intake, setProjectState, getProjectState, isPaused, projectBlocked };
