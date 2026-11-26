const fs = require('node:fs');
const path = require('node:path');

function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findBin(name, { searchPath = '', cwd = process.cwd() } = {}) {
  const candidates = name.includes('/') ? [path.resolve(cwd, name)] : searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name));
  return candidates.find(executable) ?? null;
}

module.exports = { findBin, executable };
