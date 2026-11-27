const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const board = require('./board/store.cjs');
const { syncLine } = require('./board/bug-groups.cjs');

const NAME = 'board';
const result = (level, detail) => ({ level, name: NAME, detail });

function boardState(db, now) {
  const versions = db.prepare("SELECT project, version FROM versions WHERE state = 'open' AND polling = 1 ORDER BY project, version").all();
  const syncs = versions.map(({ project, version }) => ({ project, version, sync: board.syncOf(db, project, version) }));
  const viewers = db.prepare('SELECT COUNT(*) AS n FROM viewer_tokens WHERE revoked_at IS NULL AND expires_at > ?').get(now).n;
  return { syncs, viewers };
}

function checkBoard({ secretsDir, dbFile }) {
  if (!fs.existsSync(path.join(secretsDir, 'jira-mcp.json'))) return result('CẢNH BÁO', 'chưa có jira-mcp.json, board không có bug Jira');
  if (!fs.existsSync(dbFile)) return result('CẢNH BÁO', 'chưa có dữ liệu');
  const now = Date.now();
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const { syncs, viewers } = boardState(db, now);
    const lines = syncs.map(({ project, version, sync }) => `${project} ${version} ${syncLine(sync, now)}`);
    const detail = `${lines.length ? lines.join(', ') : 'không bản nào đang theo dõi'}; ${viewers} link xem còn hạn`;
    return result(syncs.every(({ sync }) => sync?.ok === true) ? 'ĐẠT' : 'CẢNH BÁO', detail);
  } finally {
    db.close();
  }
}

module.exports = { checkBoard };
