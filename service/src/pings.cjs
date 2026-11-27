const { isWorking, addWorkingMinutes } = require('./work-hours.cjs');
const { buildContent } = require('./ping-message.cjs');

const WORK_MINUTES_PER_DAY = 540;
const ROLES = { po: 'po', qa: 'qa', dev: 'devOnCall' };
const DAILY_RULE = { qa: 'P02', dev: 'P03' };

function openWait(db, { project, role, subject, link = null }, now) {
  db.prepare(
    `INSERT INTO waits (project, role, subject, link, opened_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project, role, subject) WHERE state = 'open' DO NOTHING`,
  ).run(project, role, subject, link, now);
  return db
    .prepare(`SELECT id FROM waits WHERE project = ? AND role = ? AND subject = ? AND state = 'open'`)
    .get(project, role, subject).id;
}

function resolveWait(db, id, now) {
  const result = db.prepare(`UPDATE waits SET state = 'resolved', resolved_at = ? WHERE id = ? AND state = 'open'`).run(now, id);
  return result.changes > 0;
}

function intervalMinutes(wait, rules) {
  if (wait.role !== 'po') return rules[DAILY_RULE[wait.role]].every_working_days * WORK_MINUTES_PER_DAY;
  const p = rules.P01;
  return wait.ping_count > 0 && wait.ping_count >= p.daily_after_ping ? WORK_MINUTES_PER_DAY : p.every_working_hours * 60;
}

const NOTICE_ROLES = ['po', 'dev'];
const isNotice = wait => NOTICE_ROLES.includes(wait.role) && wait.ping_count === 0;

function dueAt(wait, rules) {
  if (isNotice(wait)) return wait.opened_at;
  const base = wait.ping_count === 0 ? wait.opened_at : wait.last_ping_at;
  return addWorkingMinutes(addWorkingMinutes(base, intervalMinutes(wait, rules)), 0);
}

function mentionsFor(role, people, waits, rules) {
  const mentions = [people[ROLES[role]]];
  const backupFrom = role === 'po' ? rules.P01.backup_from_ping : null;
  if (people.poBackup && backupFrom !== null && waits.some(w => w.ping_count + 1 >= backupFrom)) mentions.push(people.poBackup);
  return mentions;
}

function duePings(db, { project, rules, now, skip = new Set() }) {
  const working = isWorking(now);
  const open = db
    .prepare(`SELECT * FROM waits WHERE project = ? AND state = 'open' AND (retry_at IS NULL OR retry_at <= ?) ORDER BY id`)
    .all(project.key, now)
    .filter(w => !skip.has(w.id) && (working || isNotice(w)));
  const groups = [];
  for (const role of Object.keys(ROLES)) {
    const waits = open.filter(w => w.role === role);
    if (!waits.some(w => dueAt(w, rules) <= now)) continue;
    const mentions = mentionsFor(role, project.people, waits, rules);
    groups.push({
      key: `${project.key}:${role}`,
      role,
      mentions,
      content: buildContent({ mentions, projectKey: project.key, waits, now }),
      waitIds: waits.map(w => w.id),
    });
  }
  return groups;
}

function inClause(ids) {
  return ids.map(() => '?').join(',');
}

function recordPing(db, waitIds, now, { ok = true } = {}) {
  if (!ok || waitIds.length === 0) return;
  db.prepare(
    `UPDATE waits SET ping_count = ping_count + 1, last_ping_at = ?, retry_at = NULL
     WHERE state = 'open' AND id IN (${inClause(waitIds)})`,
  ).run(now, ...waitIds);
}

function recordPingFailure(db, waitIds, retryAt) {
  if (waitIds.length === 0) return;
  db.prepare(`UPDATE waits SET retry_at = ? WHERE state = 'open' AND id IN (${inClause(waitIds)})`).run(retryAt, ...waitIds);
}

module.exports = { openWait, resolveWait, duePings, recordPing, recordPingFailure };
