const fs = require('node:fs');
const path = require('node:path');
const { pathsFor } = require('./git.cjs');
const { checkBatch, checkSha } = require('./prompts-data.cjs');

const RUN_STEP = path.join(__dirname, '..', 'run-step.cjs');

function realDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(dir) !== dir) throw new Error(`${dir} phải là thư mục thật`);
  return dir;
}

function specDir(kind, { batchId, sha }, { dzHome, project }) {
  return path.join(pathsFor({ dzHome, project }).batches, checkBatch(batchId), `${kind}-${checkSha(sha, 'sha').slice(0, 12)}`);
}

function writeSpec(dir, steps) {
  const file = path.join(realDir(dir), 'spec.json');
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, `${JSON.stringify({ steps }, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  return { bin: process.execPath, args: [RUN_STEP, file] };
}

const minutes = count => count * 60 * 1000;

module.exports = { specDir, writeSpec, minutes };
