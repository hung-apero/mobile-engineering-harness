const fs = require('node:fs');
const path = require('node:path');
const { loadProjects } = require('./projects.cjs');

const HARNESS_FILES = ['skills/feature/scripts/headless_check.py', 'skills/spec-clear/SKILL.md'];
const result = (level, name, detail) => ({ level, name, detail });
const isFile = file => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;

function checkOverlay({ dzHome, projectsDir }) {
  const name = 'overlay';
  const enabled = [...loadProjects(projectsDir, { dzHome }).projects.values()].filter(project => project.enabled);
  const lost = enabled.map(project => `${project.key}.overlay.yaml`).filter(file => !isFile(path.join(projectsDir, file)));
  if (lost.length) return result('THIẾU', name, `chưa có ${lost.join(', ')} trong ${projectsDir}`);
  return result('ĐẠT', name, `${enabled.length} project`);
}

function checkPython({ exec, baseEnv }) {
  const name = 'python3';
  const out = exec('python3', ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], baseEnv);
  if (!out.ok) return result('THIẾU', name, out.missing ? 'chưa cài python3' : 'python3 không chạy được');
  const version = out.stdout.trim();
  const [major, minor] = version.split('.').map(Number);
  return major > 3 || (major === 3 && minor >= 9) ? result('ĐẠT', name, version) : result('THIẾU', name, `${version}, cần ≥ 3.9`);
}

function harnessFilesProblem(dir) {
  const lost = HARNESS_FILES.filter(file => !isFile(path.join(dir, file)));
  return lost.length ? `harness ghim thiếu ${lost.join(', ')}` : null;
}

module.exports = { checkOverlay, checkPython, harnessFilesProblem };
