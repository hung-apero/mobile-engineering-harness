const kv = require('../kv.cjs');
const store = require('./store.cjs');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const FAST = 3 * MINUTE;
const SLOW = 15 * MINUTE;
const offKey = (project, version) => `bug-off:${project}:${version}`;
const PROJECT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const SAFE_NAME = /^[^"\\\r\n]+$/;

function stamp(ms) {
  if (!Number.isFinite(ms)) throw new Error(`mốc thời gian không hợp lệ: ${ms}`);
  return new Date(ms + 7 * HOUR).toISOString().slice(0, 16).replace('T', ' ');
}

function jql(project, version, now, options = {}) {
  if (typeof project !== 'string' || !PROJECT_RE.test(project)) throw new Error(`mã project không hợp lệ: ${project}`);
  store.checkVersion(version);
  const { waiting, keys, fixVersions = [], baselineAt = now } = options;
  if (!Array.isArray(waiting) || waiting.length === 0 || !waiting.every(s => typeof s === 'string' && SAFE_NAME.test(s))) {
    throw new Error('waiting phải là danh sách tên trạng thái không chứa nháy, gạch chéo ngược, xuống dòng');
  }
  if (keys !== undefined && (!Array.isArray(keys) || keys.length === 0 || !keys.every(k => typeof k === 'string' && store.KEY_RE.test(k)))) {
    throw new Error('keys phải là danh sách mã ticket hợp lệ');
  }
  if (!Array.isArray(fixVersions) || !fixVersions.every(name => typeof name === 'string' && store.VERSION_RE.test(name))) throw new Error('fixVersions phải là danh sách tên version hợp lệ');
  const since = stamp(baselineAt);
  const list = fixVersions.map(name => `"${name}"`).join(', ');
  const own = fixVersions.length ? `(fixVersion is EMPTY OR fixVersion in (${list}))` : 'fixVersion is EMPTY';
  const reasons = [`(created >= "${since}" AND ${own})`];
  if (fixVersions.length) reasons.push(`fixVersion in (${list})`);
  reasons.push('labels = "claude-fix"', `status changed to Reopened after "${since}" AND ${own}`);
  const lines = [
    `project = ${project} AND issuetype = Bug AND status in (${waiting.map(s => `"${s}"`).join(', ')})`,
    'AND (labels is EMPTY OR labels not in ("human-only")) AND created <= -2m',
    `AND (${reasons.join(' OR ')})`,
  ];
  if (keys) lines.push(`AND key in (${keys.join(', ')})`);
  lines.push('ORDER BY priority DESC, created ASC');
  return lines.join('\n');
}

function pollInterval(version, now, quietHours = 24) {
  if (!version || !version.polling) return null;
  const since = Math.max(version.lastNewAt ?? 0, version.baselineAt ?? 0);
  return now - since >= quietHours * HOUR ? SLOW : FAST;
}

function mustGet(db, project, version) {
  const row = store.getVersion(db, project, version);
  if (!row) throw new Error(`chưa có version ${project} ${version}`);
  return row;
}

const operatorOff = (db, project, version) => kv.get(db, offKey(project, version)) === true;

function setPolling(db, project, version, on, now) {
  return store.inTransaction(db, () => {
    mustGet(db, project, version);
    if (on) kv.del(db, offKey(project, version));
    else kv.set(db, offKey(project, version), true, now);
    db.prepare('UPDATE versions SET polling = ?, baseline_at = CASE WHEN ? = 1 THEN COALESCE(baseline_at, ?) ELSE baseline_at END WHERE project = ? AND version = ?')
      .run(on ? 1 : 0, on ? 1 : 0, now, project, version);
    return store.getVersion(db, project, version);
  });
}

function recordBuildSent(db, project, version, now) {
  return store.inTransaction(db, () => {
    store.ensureVersion(db, { project, version });
    if (operatorOff(db, project, version)) return store.getVersion(db, project, version);
    db.prepare('UPDATE versions SET polling = 1, baseline_at = COALESCE(baseline_at, ?) WHERE project = ? AND version = ?')
      .run(now, project, version);
    return store.getVersion(db, project, version);
  });
}

function recordPoll(db, project, version, { newCount, now }) {
  return store.inTransaction(db, () => {
    const row = mustGet(db, project, version);
    if (!row.polling) return row;
    db.prepare('UPDATE versions SET last_poll_at = ?, last_new_at = CASE WHEN ? > 0 THEN ? ELSE last_new_at END WHERE project = ? AND version = ?')
      .run(now, newCount, now, project, version);
    return store.getVersion(db, project, version);
  });
}

module.exports = { jql, pollInterval, setPolling, operatorOff, offKey, recordBuildSent, recordPoll, FAST, SLOW };
