const fs = require('node:fs');
const path = require('node:path');
const { loadProjects } = require('./projects.cjs');

const warn = (name, detail) => ({ level: 'CẢNH BÁO', name, detail });

function checkE2e({ dzHome, projectsDir, exec, baseEnv }) {
  const name = 'e2e';
  const projects = fs.existsSync(projectsDir) ? [...loadProjects(projectsDir, { dzHome }).projects.keys()] : [];
  if (projects.length === 0) return { level: 'ĐẠT', name, detail: 'chưa project nào' };
  const problems = [];
  if (!fs.existsSync(path.join(dzHome, 'android-test-harness'))) problems.push(`chưa có ${path.join(dzHome, 'android-test-harness')}`);
  if (!exec('maestro', ['--version'], baseEnv).ok) problems.push('không chạy được maestro');
  for (const key of projects) if (!fs.existsSync(path.join(dzHome, 'e2e', `${key}.json`))) problems.push(`chưa có e2e/${key}.json`);
  return problems.length ? warn(name, `${problems.join('; ')} (bản sẽ không có điều kiện 6)`) : { level: 'ĐẠT', name, detail: `${projects.length} project` };
}

module.exports = { checkE2e };
