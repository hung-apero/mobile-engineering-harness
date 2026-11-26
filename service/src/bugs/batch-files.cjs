const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const { batchDir, removeWorktree } = require('./landing.cjs');
const { pathsFor, check, BATCH_ID } = require('./git.cjs');

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const STEP_DIR = /^(?:gate|build)-[0-9a-f]{12}$/;
const EVIDENCE = /^(?:[\w.-]+\.log|result\.json)$/;

function privateDir(root, ...names) {
  return names.reduce((parent, name) => {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(dir) !== dir) throw new Error(`${dir} phải là thư mục thật`);
    fs.chmodSync(dir, 0o700);
    return dir;
  }, root);
}

async function keepEvidence({ dzHome, project, batchId }) {
  const dir = batchDir({ dzHome, project, batchId });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !STEP_DIR.test(entry.name)) continue;
    const from = path.join(dir, entry.name);
    const files = fs.readdirSync(from, { withFileTypes: true }).filter(f => f.isFile() && EVIDENCE.test(f.name));
    if (!files.length) continue;
    const to = privateDir(fs.realpathSync(dzHome), 'logs', 'batches', `${project.key}-${batchId}`, entry.name);
    for (const { name } of files) {
      await fs.promises.rename(path.join(from, name), path.join(to, name));
      await fs.promises.chmod(path.join(to, name), 0o600);
    }
  }
}

async function removeBatchFiles({ dzHome, project, batchId, git }) {
  const dir = batchDir({ dzHome, project, batchId });
  await keepEvidence({ dzHome, project, batchId });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) await fs.promises.rm(path.join(dir, entry.name), { recursive: true, force: true });
  }
  await removeWorktree({ dzHome, project, batchId, git });
}

async function pruneAbandoned({ db, dzHome, project, now }) {
  const { batches } = pathsFor({ dzHome, project });
  const removed = [];
  for (const { id, updatedAt } of store.listBatches(db, { project: project.key, states: ['abandoned'] })) {
    const dir = path.join(batches, check(BATCH_ID, id, 'batch.id'));
    if (now - updatedAt < KEEP_MS || !fs.existsSync(dir)) continue;
    await removeBatchFiles({ dzHome, project, batchId: id });
    await fs.promises.rm(dir, { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

module.exports = { removeBatchFiles, pruneAbandoned };
