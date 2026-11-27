const PRIORITIES = { highest: 0, high: 1, medium: 2, low: 3 };
const VERSION_RE = /^[0-9][0-9A-Za-z.\-]*$/;
const KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const FINISHED = ['done', 'abandoned'];

const parse = text => (text == null ? null : JSON.parse(text));

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

function toVersion(row) {
  if (!row) return null;
  return {
    project: row.project,
    version: row.version,
    branch: row.branch,
    state: row.state,
    baselineAt: row.baseline_at,
    polling: row.polling === 1,
    lastNewAt: row.last_new_at,
    lastPollAt: row.last_poll_at,
    buildFailures: row.build_failures,
  };
}

function toTicket(row) {
  if (!row) return null;
  return {
    project: row.project,
    key: row.key,
    version: row.version,
    priority: row.priority,
    state: row.state,
    verdict: row.verdict,
    batchId: row.batch_id,
    reopenCount: row.reopen_count,
    fingerprint: row.fingerprint,
    updatedAt: row.updated_at,
  };
}

function toBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    project: row.project,
    version: row.version,
    kind: row.kind,
    state: row.state,
    keys: parse(row.keys),
    data: parse(row.data),
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
  };
}

function checkVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error(`version không hợp lệ: ${version}`);
}

function ensureVersion(db, { project, version, branch, now }) {
  checkVersion(version);
  db.prepare('INSERT OR IGNORE INTO versions (project, version, branch) VALUES (?, ?, ?)')
    .run(project, version, branch ?? `dz/release-${version}`);
  return getVersion(db, project, version);
}

function getVersion(db, project, version) {
  return toVersion(db.prepare('SELECT * FROM versions WHERE project = ? AND version = ?').get(project, version));
}

function listVersions(db, project) {
  return db.prepare('SELECT * FROM versions WHERE project = ? ORDER BY version').all(project).map(toVersion);
}

function getTicket(db, project, key) {
  return toTicket(db.prepare('SELECT * FROM tickets WHERE project = ? AND key = ?').get(project, key));
}

function listTickets(db, { project, version, states } = {}) {
  const where = ['project = ?'];
  const args = [project];
  if (version !== undefined) {
    where.push('version = ?');
    args.push(version);
  }
  if (states) {
    where.push(`state IN (${states.map(() => '?').join(', ')})`);
    args.push(...states);
  }
  return db.prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY priority, updated_at, key`)
    .all(...args).map(toTicket);
}

function setVerdict(db, project, key, verdict, now) {
  return inTransaction(db, () => {
    const info = db.prepare(
      "UPDATE tickets SET verdict = ?, state = 'concluded', batch_id = NULL, updated_at = ? WHERE project = ? AND key = ? AND state IN ('accepted', 'batched', 'concluded')",
    ).run(verdict, now, project, key);
    if (info.changes === 0) throw new Error(`không đặt được kết luận cho ${key}`);
    return getTicket(db, project, key);
  });
}

function setTicketState(db, project, key, from, to, now) {
  const info = db.prepare('UPDATE tickets SET state = ?, updated_at = ? WHERE project = ? AND key = ? AND state = ?')
    .run(to, now, project, key, from);
  return info.changes === 1;
}

function getBatch(db, id) {
  return toBatch(db.prepare('SELECT * FROM batches WHERE id = ?').get(id));
}

function listBatches(db, { project, version, states } = {}) {
  const where = ['project = ?'];
  const args = [project];
  if (version !== undefined) {
    where.push('version = ?');
    args.push(version);
  }
  if (states) {
    where.push(`state IN (${states.map(() => '?').join(', ')})`);
    args.push(...states);
  }
  return db.prepare(`SELECT * FROM batches WHERE ${where.join(' AND ')} ORDER BY id`).all(...args).map(toBatch);
}

function transitionBatch(db, id, from, to, now, data) {
  return inTransaction(db, () => {
    const info = db.prepare('UPDATE batches SET state = ?, updated_at = ?, data = COALESCE(?, data) WHERE id = ? AND state = ?')
      .run(to, now, data === undefined ? null : JSON.stringify(data), id, from);
    if (info.changes === 0) return null;
    if (FINISHED.includes(to)) {
      db.prepare("UPDATE tickets SET batch_id = NULL, state = 'accepted', updated_at = ? WHERE batch_id = ? AND state = 'batched'").run(now, id);
    }
    return getBatch(db, id);
  });
}

module.exports = {
  PRIORITIES, KEY_RE, VERSION_RE, FINISHED, inTransaction, checkVersion, ensureVersion, getVersion, listVersions,
  getTicket, listTickets, setVerdict, setTicketState, getBatch, listBatches, transitionBatch, toBatch,
};
