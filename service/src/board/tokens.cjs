const crypto = require('node:crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function issueViewer(db, { keys = [], days = 90 }, now) {
  const token = crypto.randomBytes(32).toString('base64url');
  const info = db.prepare('INSERT INTO viewer_tokens (hash, keys, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha(token), JSON.stringify(keys), now + days * DAY_MS, now);
  return { id: Number(info.lastInsertRowid), token };
}

function resolveViewer(db, token, now) {
  const row = db.prepare('SELECT id, keys, expires_at, revoked_at FROM viewer_tokens WHERE hash = ?').get(sha(token));
  if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
  return { id: row.id, keys: JSON.parse(row.keys) };
}

function listViewers(db) {
  return db.prepare('SELECT id, keys, expires_at, revoked_at FROM viewer_tokens ORDER BY id').all()
    .map(row => ({ id: row.id, keys: JSON.parse(row.keys), expiresAt: row.expires_at, revoked: row.revoked_at !== null }));
}

function revokeViewer(db, id, now) {
  return db.prepare('UPDATE viewer_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes === 1;
}

module.exports = { issueViewer, resolveViewer, listViewers, revokeViewer };
