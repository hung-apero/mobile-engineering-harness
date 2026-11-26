const { workingDayKey } = require('./work-hours.cjs');
const { redact } = require('./redact.cjs');
const { plainText } = require('./plain-text.cjs');

const OFFSET = 7 * 3600 * 1000;
const REPORT_FROM_MINUTE = 17 * 60 + 30;
const LIMIT = 1800;
const TAIL = 40;
const DAY_MS = 24 * 3600 * 1000;

const clean = (text, max) => {
  const flat = redact(text ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return plainText(flat);
  let end = max - 1;
  if (/[\ud800-\udbff]/.test(flat[end - 1] ?? '')) end--;
  return plainText(`${flat.slice(0, end)}…`);
};

const local = now => new Date(now + OFFSET);
const keyOf = project => (typeof project === 'string' ? project : project.key);

function dueSlot(now, weekdays) {
  const d = local(now);
  return weekdays.includes(d.getUTCDay()) && d.getUTCHours() * 60 + d.getUTCMinutes() >= REPORT_FROM_MINUTE;
}

function isoWeek(now) {
  const d = local(now);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const periodOf = (kind, now) => (kind === 'digest' ? workingDayKey(now) : isoWeek(now));

function alreadySent(db, kind, project, now) {
  return Boolean(
    db.prepare('SELECT 1 FROM sent_reports WHERE kind = ? AND project = ? AND period = ?').get(kind, project, periodOf(kind, now)),
  );
}

function lastSentAt(db, kind, project) {
  return db.prepare('SELECT MAX(sent_at) AS at FROM sent_reports WHERE kind = ? AND project = ?').get(kind, project).at;
}

function markReportSent(db, kind, project, now) {
  db.prepare('INSERT OR REPLACE INTO sent_reports (kind, project, period, sent_at) VALUES (?, ?, ?, ?)').run(
    kind,
    project ?? '',
    periodOf(kind, now),
    now,
  );
}

function waited(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes} phút`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} giờ`;
  return `${Math.floor(minutes / 1440)} ngày`;
}

function resultText(result) {
  return clean(typeof result === 'string' ? result : result?.text || result?.error, 120);
}

function finishedLine(job) {
  const label = job.state === 'done' ? 'xong' : 'lỗi';
  const detail = resultText(JSON.parse(job.result ?? 'null'));
  return `- ${clean(job.kind, 20)} ${clean(job.key, 60)}: ${label}${detail ? ` — ${detail}` : ''}`;
}

function parkedLine(db, job) {
  let reason = clean(job.park_reason, 1000);
  if (!/^X\d+/.test(reason)) {
    const decision = db.prepare('SELECT code FROM decisions WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(job.id);
    if (decision) reason = `${clean(decision.code, 10)}: ${reason}`;
  }
  return `- ${clean(job.kind, 20)} ${clean(job.key, 60)}: đang đỗ — ${clean(reason, 120)}`;
}

function assemble(head, sections) {
  const out = [head];
  let used = head.length;
  let left = sections.filter(s => s.lines.length).length;
  for (const { title, lines } of sections) {
    if (!lines.length) continue;
    const share = Math.floor((LIMIT - used) / left--);
    let sectionUsed = title.length + 1;
    const kept = [];
    for (const line of lines) {
      const more = lines.length - kept.length - 1;
      const reserve = more > 0 ? TAIL : 0;
      if (sectionUsed + line.length + 1 + reserve > share) break;
      kept.push(line);
      sectionUsed += line.length + 1;
    }
    const hidden = lines.length - kept.length;
    out.push(title, ...kept);
    if (hidden > 0) out.push(`… và ${hidden} việc nữa`);
    used += title.length + kept.reduce((n, l) => n + l.length + 1, 0) + (hidden > 0 ? TAIL : 0) + 1;
  }
  while (out.length > 1 && out.join('\n').length > LIMIT) out.pop();
  return out.join('\n');
}

function digest(db, { project, now }) {
  const key = keyOf(project);
  if (!dueSlot(now, [1, 2, 3, 4, 5]) || alreadySent(db, 'digest', key, now)) return null;
  const since = lastSentAt(db, 'digest', key) ?? now - DAY_MS;
  const finished = db
    .prepare(
      `SELECT * FROM jobs WHERE project = ? AND state IN ('done', 'failed') AND finished_at > ? AND finished_at <= ?
       ORDER BY finished_at, id`,
    )
    .all(key, since, now);
  const parked = db.prepare(`SELECT * FROM jobs WHERE project = ? AND state = 'parked' ORDER BY id`).all(key);
  const waits = db.prepare(`SELECT * FROM waits WHERE project = ? AND state = 'open' ORDER BY id`).all(key);
  if (!finished.length && !parked.length && !waits.length) return null;
  return assemble(`Tóm tắt ngày ${workingDayKey(now)} — ${clean(key, 40)}`, [
    { title: 'Việc đã kết thúc:', lines: finished.map(finishedLine) },
    { title: 'Việc đang đỗ:', lines: parked.map(job => parkedLine(db, job)) },
    {
      title: 'Đang chờ người:',
      lines: waits.map(w => `- ${clean(w.role, 10)}: ${clean(w.subject, 80)} (chờ ${waited(now - w.opened_at)})`),
    },
  ]);
}

function weeklyMissing(db, { now }) {
  if (!dueSlot(now, [5]) || alreadySent(db, 'weekly', '', now)) return null;
  const since = lastSentAt(db, 'weekly', '') ?? now - 7 * DAY_MS;
  const rows = db
    .prepare('SELECT * FROM missing_rules WHERE last_seen > ? AND last_seen <= ? ORDER BY count DESC, id')
    .all(since, now);
  if (!rows.length) return null;
  const lines = rows.map(r => `- [${clean(r.project, 40)}] ${clean(r.situation, 120)} (${r.count} lần) — đề xuất: ${clean(r.proposal, 120)}`);
  return assemble(`Tuần ${isoWeek(now)} — tình huống chưa có luật (X08)`, [{ title: 'Cần quyết định:', lines }]);
}

module.exports = { digest, weeklyMissing, markReportSent };
