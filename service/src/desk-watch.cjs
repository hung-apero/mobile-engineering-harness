const kv = require('./kv.cjs');
const inbox = require('./inbox.cjs');
const { openWait, resolveWait } = require('./pings.cjs');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const OFFSET = 7 * HOUR;
const DAILY_HOUR = 4;
const IDLE_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 5;
const BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 8 * 60 * 1000;
const RESTARTS = 'desk:restarts';
const HOLD = 'desk:hold';
const SUBJECT = 'Phiên điều phối Discord khởi động lại quá 5 lần trong một giờ, cần dev xem (dz desk status)';

const restartsIn = (db, now) => (kv.get(db, RESTARTS) ?? []).filter(at => at > now - HOUR && at <= now);

function noteRestart(db, now) {
  kv.set(db, RESTARTS, [...restartsIn(db, now), now], now);
}

function nextAllowed(db, now) {
  const recent = restartsIn(db, now);
  if (recent.length === 0) return 0;
  return recent.at(-1) + Math.min(BACKOFF_MS * 2 ** (recent.length - 1), MAX_BACKOFF_MS);
}

function reset(db, now) {
  clearHold(db, now);
  kv.del(db, RESTARTS);
}

const isOpen = (db, id) => db.prepare("SELECT 1 FROM waits WHERE id = ? AND state = 'open'").get(id) !== undefined;

function clearHold(db, now) {
  const hold = kv.get(db, HOLD);
  if (!hold) return;
  kv.transaction(db, () => {
    for (const id of hold.waits) resolveWait(db, id, now);
    kv.del(db, HOLD);
    kv.del(db, RESTARTS);
  });
}

function isHeld(db, now) {
  const hold = kv.get(db, HOLD);
  if (!hold) return false;
  if (hold.waits.every(id => isOpen(db, id))) return true;
  clearHold(db, now);
  return false;
}

function openHold(db, projects, now) {
  kv.transaction(db, () => {
    const waits = projects.map(project => openWait(db, { project: project.key, role: 'dev', subject: SUBJECT }, now));
    kv.set(db, HOLD, { waits, since: now }, now);
  });
}

const lastAck = db => db.prepare('SELECT MAX(acked_at) AS at FROM inbox').get().at ?? 0;
const lastSeen = db => db.prepare('SELECT MAX(seen_at) AS at FROM inbox').get().at ?? 0;

function isStuck(db, startedAt, now) {
  if (inbox.overdue(db, now).length === 0) return false;
  return now - Math.max(startedAt, lastAck(db)) >= inbox.OVERDUE_MS;
}

function dailyMark(now) {
  const local = now + OFFSET;
  const mark = Math.floor(local / DAY) * DAY + DAILY_HOUR * HOUR;
  return (mark <= local ? mark : mark - DAY) - OFFSET;
}

function isDailyDue(db, startedAt, now) {
  if (startedAt >= dailyMark(now) || inbox.pending(db, 1).length > 0) return false;
  return now - Math.max(startedAt, lastAck(db), lastSeen(db)) >= IDLE_MS;
}

module.exports = { restartsIn, noteRestart, nextAllowed, isHeld, openHold, clearHold, reset, isStuck, isDailyDue, MAX_RESTARTS };
