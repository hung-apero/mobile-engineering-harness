const kv = require('../kv.cjs');
const { inTransaction } = require('../bugs/store.cjs');

const syncKey = (project, version) => `board-sync:${project}:${version}`;

function replaceBugs(db, { project, version, bugs }, now) {
  inTransaction(db, () => {
    db.prepare('DELETE FROM board_bugs WHERE project = ? AND version = ?').run(project, version);
    const insert = db.prepare(`INSERT INTO board_bugs (project, version, key, summary, status, priority, assignee, updated_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project, key) DO UPDATE SET version = excluded.version, summary = excluded.summary,
      status = excluded.status, priority = excluded.priority, assignee = excluded.assignee, updated_at = excluded.updated_at, synced_at = excluded.synced_at`);
    for (const bug of bugs) insert.run(project, version, bug.key, bug.summary, bug.status, bug.priority, bug.assignee, bug.updatedAt, now);
  });
}

function bugsOf(db, project) {
  return db.prepare('SELECT * FROM board_bugs WHERE project = ? ORDER BY version, key').all(project).map(row => ({
    version: row.version, key: row.key, summary: row.summary, status: row.status, priority: row.priority, assignee: row.assignee, updatedAt: row.updated_at,
  }));
}

const syncOf = (db, project, version) => kv.get(db, syncKey(project, version));
const saveSync = (db, project, version, value, now) => kv.set(db, syncKey(project, version), value, now);

module.exports = { replaceBugs, bugsOf, syncOf, saveSync };
