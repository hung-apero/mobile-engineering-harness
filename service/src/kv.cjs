function transaction(db, fn) {
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

function get(db, key) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function set(db, key, value, now) {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}

function del(db, key) {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

function keys(db, prefix) {
  return db.prepare('SELECT key FROM kv WHERE substr(key, 1, length(?)) = ? ORDER BY key').all(prefix, prefix).map(row => row.key);
}

module.exports = { transaction, get, set, del, keys };
