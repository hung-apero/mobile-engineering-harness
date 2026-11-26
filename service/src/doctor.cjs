const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePaths } = require('./context.cjs');
const { loadRules } = require('./rules.cjs');
const { loadProjects } = require('./projects.cjs');
const { workerEnv } = require('./worker.cjs');
const health = require('./health.cjs');
const { firstLine } = require('./redact.cjs');
const { protectedFolder, CODE_DIR } = require('./protected-path.cjs');
const { runCommand } = require('./doctor-exec.cjs');
const { checkSandbox, checkKeychain } = require('./doctor-sandbox.cjs');
const { checkConfluence, checkFigma, checkWeb } = require('./doctor-specs.cjs');
const { deskChecks } = require('./desk-doctor.cjs');
const { checkE2e } = require('./doctor-e2e.cjs');
const { checkPython, harnessFilesProblem } = require('./doctor-v2.cjs');

const MIN_NODE = 24;
const MIN_CLAUDE = [2, 1, 332];

const ok = (name, detail) => ({ level: 'ĐẠT', name, detail });
const missing = (name, detail) => ({ level: 'THIẾU', name, detail });
const warn = (name, detail) => ({ level: 'CẢNH BÁO', name, detail });

function why(out) {
  if (out.missing) return 'không tìm thấy lệnh';
  return out.timedOut ? 'quá 10 giây không trả lời' : 'lệnh báo lỗi';
}

function checkNode() {
  const version = process.versions.node;
  return Number(version.split('.')[0]) >= MIN_NODE ? ok('node', version) : missing('node', `${version}, cần ≥ ${MIN_NODE}`);
}

function atLeast(found, wanted) {
  const index = found.findIndex((n, i) => n !== wanted[i]);
  return index === -1 || found[index] > wanted[index];
}

function checkClaude({ bin, exec, env }) {
  const out = exec(bin, ['--version'], env);
  const match = out.ok && out.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return missing('claude', out.ok ? 'không đọc được phiên bản' : why(out));
  const found = match.slice(1, 4).map(Number);
  return atLeast(found, MIN_CLAUDE) ? ok('claude', match[0]) : missing('claude', `${match[0]}, cần ≥ ${MIN_CLAUDE.join('.')}`);
}

function checkLogin({ bin, exec, env }) {
  const name = 'đăng nhập claude';
  if (env.CLAUDE_CONFIG_DIR && !fs.existsSync(env.CLAUDE_CONFIG_DIR)) return missing(name, `chưa có ${env.CLAUDE_CONFIG_DIR}`);
  const out = exec(bin, ['auth', 'status'], env);
  if (out.missing || out.timedOut) return missing(name, why(out));
  try {
    if (JSON.parse(out.stdout).loggedIn === true) return ok(name, env.CLAUDE_CONFIG_DIR ?? 'cấu hình dùng chung');
  } catch {}
  return missing(name, 'chưa đăng nhập');
}

function checkGh({ exec, env }) {
  const out = exec('gh', ['auth', 'status'], env);
  return out.ok ? ok('gh', 'đã đăng nhập') : missing('gh', why(out));
}

function checkAdb({ exec, baseEnv }) {
  const out = exec('adb', ['devices'], baseEnv);
  if (!out.ok) return missing('adb', why(out));
  const count = out.stdout.split('\n').filter(row => /\tdevice\s*$/.test(row)).length;
  return count ? ok('adb', `${count} thiết bị`) : warn('adb', 'không có thiết bị nào sẵn sàng');
}

function checkDisk({ dzHome, rulesDir, freeGb }) {
  const name = 'đĩa trống';
  let dir = dzHome;
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const free = freeGb(dir);
  const shown = `${free.toFixed(1)} GB`;
  let min;
  try {
    min = loadRules(rulesDir).rules.X05.min_free_gb;
  } catch {
    return warn(name, `${shown}, không đọc được mức tối thiểu`);
  }
  return free >= min ? ok(name, shown) : missing(name, `${shown}, cần ≥ ${min} GB`);
}

function checkSecrets({ dzHome, secretsDir }) {
  const name = 'file bí mật';
  if (!fs.existsSync(secretsDir)) return missing(name, `chưa có ${secretsDir}`);
  const bad = [];
  for (const dir of [dzHome, secretsDir]) if ((fs.lstatSync(dir).mode & 0o777) !== 0o700) bad.push(`${dir} phải có quyền 700`);
  for (const entry of fs.readdirSync(secretsDir)) {
    const info = fs.lstatSync(path.join(secretsDir, entry));
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) bad.push(`${entry} phải là file thường có quyền 600`);
  }
  return bad.length ? missing(name, bad.join('; ')) : ok(name, 'quyền đúng');
}

function checkPower({ exec, baseEnv }) {
  const out = exec('pmset', ['-g'], baseEnv);
  if (!out.ok) return [warn('máy ngủ', why(out)), warn('tự bật lại', why(out))];
  const value = key => out.stdout.match(new RegExp(`^\\s*${key}\\s+(\\d+)`, 'm'))?.[1];
  return [
    value('sleep') === '0' ? ok('máy ngủ', 'đã tắt') : warn('máy ngủ', 'máy có thể ngủ (pmset sleep khác 0)'),
    value('autorestart') === '1' ? ok('tự bật lại', 'đã bật') : warn('tự bật lại', 'mất điện xong máy không tự bật (autorestart khác 1)'),
  ];
}

function checkCode({ codeDir, home }) {
  const name = 'mã dịch vụ';
  const folder = protectedFolder(codeDir, home);
  return folder ? warn(name, `nằm trong ${folder} (macOS chặn launchd đọc), nên chạy từ ~/.dev-zone/app`) : ok(name, codeDir);
}

function checkRules({ rulesDir }) {
  try {
    const files = fs.readdirSync(rulesDir).filter(name => path.extname(name) === '.yaml');
    for (const key of [undefined, ...files.map(f => path.basename(f, '.yaml')).filter(k => k !== 'default')]) loadRules(rulesDir, key);
    return ok('rule', `${files.length} file`);
  } catch (error) {
    return missing('rule', `${error.file ? `${path.basename(error.file)}: ` : ''}${firstLine(error)}`);
  }
}

function checkProjects({ projectsDir, dzHome }) {
  const name = 'project';
  if (!fs.existsSync(projectsDir)) return warn(name, `chưa có ${projectsDir}`);
  const { projects, errors } = loadProjects(projectsDir, { dzHome });
  if (errors.length) return missing(name, errors.map(e => `${e.file}: ${firstLine(e)}`).join('; '));
  return projects.size ? ok(name, `${projects.size} project`) : warn(name, 'chưa có project nào');
}

const WRITE_TOOLS = ['jira_transition_issue', 'jira_add_comment', 'jira_update_issue', 'jira_delete_issue', 'jira_create_issue'];

function jiraShapeProblem(server, readOnly) {
  if (typeof server?.command !== 'string' || !server.command) return 'thiếu mcpServers.jira.command';
  if (!readOnly) return null;
  if (server.env?.READ_ONLY_MODE !== 'true') return 'READ_ONLY_MODE phải là "true"';
  const tools = String(server.env?.ENABLED_TOOLS ?? '').split(',').filter(Boolean);
  if (tools.length === 0) return 'thiếu ENABLED_TOOLS';
  const writes = tools.filter(tool => WRITE_TOOLS.includes(tool));
  return writes.length ? `ENABLED_TOOLS có tool ghi: ${writes.join(', ')}` : null;
}

function checkJiraFile({ secretsDir }, file, name, readOnly) {
  const target = path.join(secretsDir, file);
  const info = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!info) return warn(name, `chưa có ${file}`);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) return missing(name, `${file} phải là file thường có quyền 600`);
  let server;
  try {
    server = JSON.parse(fs.readFileSync(target, 'utf8'))?.mcpServers?.jira;
  } catch {
    return missing(name, `${file} không phải JSON`);
  }
  const problem = jiraShapeProblem(server, readOnly);
  return problem ? missing(name, `${file}: ${problem}`) : ok(name, file);
}

const checkJiraWrite = c => checkJiraFile(c, 'jira-mcp.json', 'jira ghi', false);
const checkJiraRead = c => checkJiraFile(c, 'jira-read.json', 'jira đọc', true);

function checkHarness({ dzHome, projectsDir, exec, baseEnv }) {
  const name = 'harness';
  const dir = path.join(dzHome, 'harness');
  if (!fs.existsSync(path.join(dir, '.git'))) return warn(name, `chưa có ${dir}`);
  const head = exec('git', ['-C', dir, 'rev-parse', 'HEAD'], baseEnv);
  if (!head.ok) return missing(name, why(head));
  const sha = head.stdout.trim();
  const { projects } = loadProjects(projectsDir, { dzHome });
  const wrong = [...projects.values()].filter(p => !sha.startsWith(p.harnessCommit));
  if (wrong.length) return missing(name, `ở ${sha.slice(0, 8)}, lệch ghim của ${wrong.map(p => `${p.key} (${p.harnessCommit})`).join(', ')}`);
  const dirty = exec('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=no'], baseEnv);
  if (!dirty.ok) return missing(name, why(dirty));
  if (dirty.stdout.trim()) return missing(name, 'có file bị sửa so với commit đã ghim');
  const lost = harnessFilesProblem(dir);
  return lost ? missing(name, lost) : ok(name, sha.slice(0, 8));
}

function doctor({ env = process.env, exec = runCommand, freeGb = health.freeGb, home = os.homedir(), codeDir = CODE_DIR } = {}) {
  const paths = resolvePaths(env);
  const c = { ...paths, exec, freeGb, home, codeDir, baseEnv: env, env: workerEnv(env, paths.dzHome), bin: env.DZ_CLAUDE_BIN || 'claude' };
  const checks = {
    node: checkNode, claude: checkClaude, 'đăng nhập claude': checkLogin, gh: checkGh, adb: checkAdb, 'đĩa trống': checkDisk,
    'file bí mật': checkSecrets, 'nguồn điện': checkPower, 'mã dịch vụ': checkCode, rule: checkRules, project: checkProjects,
    'jira ghi': checkJiraWrite, 'jira đọc': checkJiraRead, harness: checkHarness, python3: checkPython,
    'confluence đọc': checkConfluence, 'figma đọc': checkFigma, 'trang web': checkWeb, desk: deskChecks, e2e: checkE2e,
    sandbox: checkSandbox, keychain: checkKeychain,
  };
  return Object.entries(checks).flatMap(([name, check]) => {
    try {
      return check(c);
    } catch (error) {
      return missing(name, firstLine(error));
    }
  });
}

module.exports = { doctor };
