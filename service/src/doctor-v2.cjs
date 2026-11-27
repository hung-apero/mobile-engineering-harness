const fs = require('node:fs');
const path = require('node:path');
const { FEATURE_FILES } = require('./bugs/workspace.cjs');
const result = (level, name, detail) => ({ level, name, detail });
const isFile = file => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;

function checkPython({ exec, baseEnv }) {
  const name = 'python3';
  const out = exec('python3', ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], baseEnv);
  if (!out.ok) return result('THIẾU', name, out.missing ? 'chưa cài python3' : 'python3 không chạy được');
  const version = out.stdout.trim();
  const [major, minor] = version.split('.').map(Number);
  return major > 3 || (major === 3 && minor >= 9) ? result('ĐẠT', name, version) : result('THIẾU', name, `${version}, cần ≥ 3.9`);
}

function harnessFilesProblem(dir) {
  const lost = FEATURE_FILES.filter(file => !isFile(path.join(dir, file)));
  return lost.length ? `harness ghim thiếu ${lost.join(', ')}` : null;
}

module.exports = { checkPython, harnessFilesProblem };
