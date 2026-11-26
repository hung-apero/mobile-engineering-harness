const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ExpectedError } = require('./run.cjs');
const { ensureHome } = require('./context.cjs');
const { protectedFolder, CODE_DIR } = require('./protected-path.cjs');

const LABEL = 'com.devzone.service';
const TEMPLATE = path.join(CODE_DIR, 'launchd', `${LABEL}.plist.tmpl`);
const DZ_BIN = path.join(CODE_DIR, 'bin', 'dz.cjs');
const MARKER = '<key>DevZoneManaged</key>';
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const REQUIRED = ['claude', 'git'];
const OPTIONAL = ['adb', 'gh', 'uvx'];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const escapeXml = value => String(value).replace(/[&<>"']/g, c => ESCAPES[c]);

function findOnPath(name, env) {
  for (const dir of (env.PATH || '').split(':').filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

function toolDirs(which, node) {
  const dirs = [path.dirname(node)];
  for (const name of REQUIRED) {
    const found = which(name);
    if (!found) throw new ExpectedError(`không tìm thấy ${name} trên PATH, không thể ghi plist`);
    dirs.push(path.dirname(found));
  }
  for (const name of OPTIONAL) {
    const found = which(name);
    if (found) dirs.push(path.dirname(found));
  }
  return [...new Set([...dirs, ...SYSTEM_PATH])];
}

function envEntries({ pathDirs, env, dzHome, shared }) {
  const entries = [['PATH', pathDirs.join(':')]];
  const java = env.JAVA_HOME;
  const android = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (java) entries.push(['JAVA_HOME', java]);
  if (android) entries.push(['ANDROID_HOME', android]);
  entries.push(['DZ_HOME', dzHome], ['LANG', env.LANG || 'en_US.UTF-8']);
  if (shared) entries.push(['DZ_CLAUDE_CONFIG', 'shared']);
  for (const name of ['DZ_WEB_HOST', 'DZ_WEB_PORT', 'DZ_SANDBOX']) if (env[name]) entries.push([name, env[name]]);
  return entries.map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n');
}

function render(values) {
  const text = fs.readFileSync(TEMPLATE, 'utf8');
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => (key === 'ENV_ENTRIES' ? values[key] : escapeXml(values[key])));
}

function plistFile(outDir) {
  return path.join(outDir, `${LABEL}.plist`);
}

function guardOwnPlist(file) {
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARKER)) {
    throw new ExpectedError(`${file} đã có và không phải do dz tạo, không ghi đè`);
  }
}

function guardCode(codeDir, home) {
  const folder = protectedFolder(codeDir, home);
  if (!folder) return;
  throw new ExpectedError(
    `mã dịch vụ nằm trong ${folder}, macOS có thể chặn launchd đọc; hãy chạy từ bản riêng ~/.dev-zone/app, hoặc thêm --allow-protected nếu vẫn muốn cài`,
  );
}

function commands(uid, file) {
  return [
    `Đã ghi ${file}`,
    'Nạp vào launchd (tự chạy lần lượt; lệnh đầu gỡ bản đang nạp, báo lỗi nếu chưa nạp thì bỏ qua):',
    `launchctl bootout gui/${uid}/${LABEL}`,
    `launchctl bootstrap gui/${uid} ${file}`,
  ];
}

function install({
  home = os.homedir(), dzHome, env = process.env, outDir, shared = false, allowProtected = false, codeDir = CODE_DIR,
  node = process.execPath, which = name => findOnPath(name, env), uid = process.getuid(),
} = {}) {
  const dir = outDir || path.join(home, 'Library', 'LaunchAgents');
  const root = path.resolve(dzHome || env.DZ_HOME || path.join(home, '.dev-zone'));
  const file = plistFile(dir);
  if (!allowProtected) guardCode(codeDir, home);
  const pathDirs = toolDirs(which, node);
  guardOwnPlist(file);
  const text = render({
    LABEL,
    NODE: node,
    DZ_BIN,
    DZ_HOME: root,
    ENV_ENTRIES: envEntries({ pathDirs, env, dzHome: root, shared }),
  });
  ensureHome(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return commands(uid, file);
}

function uninstall({ home = os.homedir(), outDir, uid = process.getuid() } = {}) {
  const file = plistFile(outDir || path.join(home, 'Library', 'LaunchAgents'));
  guardOwnPlist(file);
  const existed = fs.existsSync(file);
  if (existed) fs.rmSync(file);
  return [
    existed ? `Đã xoá ${file}` : `Không có ${file}`,
    'Gỡ khỏi launchd nếu đang nạp (tự chạy lệnh này):',
    `launchctl bootout gui/${uid}/${LABEL}`,
  ];
}

module.exports = { install, uninstall, LABEL };
