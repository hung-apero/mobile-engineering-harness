const DAY = 24 * 60 * 60 * 1000;
const VN = 7 * 60 * 60 * 1000;
const DAYS = 7;
const ACTIONS = { 'spec-approved': 'approved', 'spec-coded': 'coded', 'spec-trial-sent': 'trial' };

const dayOf = ms => new Date(ms + VN).toISOString().slice(0, 10);
const dayStart = ms => Math.floor((ms + VN) / DAY) * DAY - VN;

function activityOf(db, project, now) {
  const start = dayStart(now) - (DAYS - 1) * DAY;
  const days = Array.from({ length: DAYS }, (_, i) => ({ day: dayOf(start + i * DAY), approved: 0, coded: 0, trial: 0, bugs: 0, batches: 0 }));
  const count = (at, field) => {
    const index = Math.floor((at - start) / DAY);
    if (index >= 0 && index < DAYS) days[index][field] += 1;
  };
  const actions = Object.keys(ACTIONS);
  const decided = db.prepare(`SELECT action, at FROM decisions WHERE project = ? AND at >= ? AND action IN (${actions.map(() => '?').join(', ')})`).all(project, start, ...actions);
  for (const row of decided) count(row.at, ACTIONS[row.action]);
  for (const row of db.prepare("SELECT updated_at AS at FROM tickets WHERE project = ? AND state = 'done' AND updated_at >= ?").all(project, start)) count(row.at, 'bugs');
  for (const row of db.prepare("SELECT updated_at AS at FROM batches WHERE project = ? AND state = 'done' AND updated_at >= ?").all(project, start)) count(row.at, 'batches');
  return days;
}

module.exports = { activityOf, dayOf };
