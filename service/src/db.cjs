const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS } = require('./migrations.cjs');

function enableWal(db) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (db.prepare('PRAGMA journal_mode').get().journal_mode === 'wal') return;
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (attempt >= 100 || !/locked|busy/i.test(err.message)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function openDb(file) {
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  enableWal(db);
  db.exec('PRAGMA foreign_keys = ON');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error(`user_version ${version} mới hơn bản hiện tại (${MIGRATIONS.length})`);
  }
  for (let i = 0; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('PRAGMA user_version').get().user_version <= i) {
        db.exec(MIGRATIONS[i]);
        db.exec(`PRAGMA user_version = ${i + 1}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

module.exports = { openDb, MIGRATIONS };
