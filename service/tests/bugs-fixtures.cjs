const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');

const t = s => Date.parse(`${s}+07:00`);
const HOUR = 60 * 60 * 1000;
const memDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-bugs-')), 'dz.db'));
const issue = (key, extra = {}) => ({ key, status: 'To Do', priority: 'Medium', summary: `bug ${key}`, labels: [], commentCount: 0, attachmentCount: 0, ...extra });

module.exports = { t, HOUR, memDb, issue };
