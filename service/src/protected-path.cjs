const fs = require('node:fs');
const path = require('node:path');

const PROTECTED = ['Desktop', 'Documents', 'Downloads'];
const CODE_DIR = path.join(__dirname, '..');

function real(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

function protectedFolder(codeDir, home) {
  const code = real(codeDir);
  return PROTECTED.map(name => real(path.join(home, name))).find(dir => code === dir || code.startsWith(dir + path.sep)) ?? null;
}

module.exports = { protectedFolder, CODE_DIR };
