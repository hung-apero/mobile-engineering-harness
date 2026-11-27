const fs = require('node:fs');
const path = require('node:path');
const { SECRET_FILES } = require('./items.cjs');

const secretDir = (secretsDir, key) => path.join(secretsDir, 'newapp', key);

function ensureSecretDir(secretsDir, key) {
  const dir = secretDir(secretsDir, key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const part of [path.join(secretsDir, 'newapp'), dir]) fs.chmodSync(part, 0o700);
  return dir;
}

function readSecret(dir, name) {
  const file = path.join(dir, SECRET_FILES[name] ?? name);
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing', file };
    throw error;
  }
  if (!info.isFile()) return { state: 'wrong', file, detail: `${path.basename(file)} không phải file thường` };
  if (info.mode & 0o077) return { state: 'wrong', file, detail: `${path.basename(file)} phải có quyền 600 (chmod 600)` };
  return { state: 'ok', file };
}

function parseProperties(text) {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith('#')) props[match[1]] = match[2];
  }
  return props;
}

module.exports = { secretDir, ensureSecretDir, readSecret, parseProperties };
