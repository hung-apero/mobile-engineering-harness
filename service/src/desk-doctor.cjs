const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { loadProjects } = require('./projects.cjs');
const { readToken } = require('./discord-bot.cjs');
const { deskPaths, deskEnv, buildSettings, buildMcp, PLUGIN } = require('./desk-config.cjs');
const { findBin } = require('./desk-session.cjs');
const { deskProjects } = require('./desk.cjs');
const { buildAccess } = require('../channels/access.cjs');
const { firstLine } = require('./redact.cjs');

const ok = (name, detail) => ({ level: 'ĐẠT', name, detail });
const missing = (name, detail) => ({ level: 'THIẾU', name, detail });

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function checkTool({ baseEnv }, tool, hint) {
  const found = findBin(tool, baseEnv);
  return found ? ok(tool, found) : missing(tool, hint);
}

function checkToken({ paths }) {
  const name = 'token bot';
  try {
    readToken(paths.tokenFile);
    return ok(name, 'đúng dạng, quyền 600');
  } catch (error) {
    return missing(name, firstLine(error));
  }
}

function checkDeskLogin({ dzHome, paths, exec, baseEnv, bin }) {
  const name = 'đăng nhập desk';
  const claude = findBin(bin, baseEnv);
  const out = claude && fs.existsSync(paths.claudeConfig) ? exec(claude, ['auth', 'status'], deskEnv(baseEnv, dzHome)) : null;
  try {
    if (JSON.parse(out?.stdout ?? '').loggedIn === true) return ok(name, paths.claudeConfig);
  } catch {}
  return missing(name, `chưa đăng nhập ở ${paths.claudeConfig} (dz desk setup, bước 5)`);
}

const sameDir = (a, b) => {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
};

function checkPlugin({ paths }) {
  const name = 'plugin discord';
  try {
    const rows = readJson(path.join(paths.claudeConfig, 'plugins', 'installed_plugins.json')).plugins?.[PLUGIN] ?? [];
    const row = rows.find(item => item.scope === 'user' || sameDir(item.projectPath, paths.dir));
    if (row && fs.existsSync(row.installPath)) return ok(name, String(row.version));
  } catch {}
  return missing(name, `chưa cài ${PLUGIN} cho ${paths.dir}`);
}

function checkTrust({ paths }) {
  const name = 'tin thư mục desk';
  try {
    const { projects = {} } = readJson(path.join(paths.claudeConfig, '.claude.json'));
    if (Object.entries(projects).some(([dir, value]) => value?.hasTrustDialogAccepted === true && sameDir(dir, paths.dir))) return ok(name, paths.dir);
  } catch {}
  return missing(name, 'chưa đồng ý hộp hỏi tin thư mục (dz desk setup, bước 6)');
}

function modeProblems(paths) {
  const problems = [];
  for (const dir of [paths.dir, paths.state, paths.claudeDir]) {
    const info = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!info?.isDirectory() || (info.mode & 0o777) !== 0o700) problems.push(`${dir} phải là thư mục quyền 700`);
  }
  for (const file of [paths.access, paths.tokenEnv, paths.settings, paths.projectSettings, paths.mcp, paths.guide, paths.replyChannels]) {
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || (info.mode & 0o777) !== 0o600) problems.push(`${path.basename(file)} phải là file thường quyền 600`);
  }
  return problems;
}

function checkConfig({ dzHome, paths, projects }) {
  const name = 'cấu hình desk';
  if (!fs.existsSync(paths.settings)) return { level: 'CẢNH BÁO', name, detail: 'chưa tạo, dz desk start sẽ tạo' };
  const problems = modeProblems(paths);
  if (problems.length > 0) return missing(name, problems.join('; '));
  const wanted = [
    [paths.access, buildAccess(projects)], [paths.settings, buildSettings(paths)], [paths.mcp, buildMcp(dzHome)],
    [paths.projectSettings, { enabledPlugins: { [PLUGIN]: true } }],
  ];
  const wrong = wanted.filter(([file, value]) => !isDeepStrictEqual(readJson(file), value)).map(([file]) => path.basename(file));
  return wrong.length > 0 ? missing(name, `${wrong.join(', ')} khác bản service sinh; chạy dz desk start`) : ok(name, paths.dir);
}

function deskChecks({ dzHome, projectsDir, exec, baseEnv, bin }) {
  const loaded = fs.existsSync(projectsDir) ? loadProjects(projectsDir, { dzHome }).projects : new Map();
  const projects = deskProjects(loaded.values());
  if (projects.length === 0) return [ok('desk', 'chưa project nào khai kênh Discord, chưa dùng')];
  const c = { dzHome, paths: deskPaths(dzHome), projects, exec, baseEnv, bin };
  return [
    checkTool(c, 'tmux', 'cần cài tmux (brew install tmux)'),
    checkTool(c, 'bun', 'plugin Discord cần bun (https://bun.sh)'),
    checkToken(c), checkDeskLogin(c), checkPlugin(c), checkTrust(c), checkConfig(c),
  ];
}

module.exports = { deskChecks };
