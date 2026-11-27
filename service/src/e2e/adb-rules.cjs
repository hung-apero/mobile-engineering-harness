const path = require('node:path');

const TOKEN = /^[\w@%+=:,./#-]+$/;
const INSTALL_FLAGS = ['-r', '-g', '-d', '-t'];
const DUMPS = ['activity', 'window', 'meminfo', 'gfxinfo', 'battery', 'display', 'input_method'];
const PM_READS = ['path', 'dump'];
const PM_WRITES = ['grant', 'revoke', 'clear'];
const WEB = /^(?:https?|ftp|file|content|intent|tel|sms|smsto|mailto|javascript|data):/i;
const deny = reason => ({ ok: false, reason });
const ALLOW = { ok: true };

function installRule([...args], { apks }) {
  const file = args.pop();
  if (args.some(flag => !INSTALL_FLAGS.includes(flag))) return deny('cờ install không được phép');
  if (typeof file !== 'string' || !apks.includes(path.resolve(file))) return deny('chỉ được cài APK của việc này');
  return { ok: true, journal: { verb: 'install', apk: path.resolve(file), update: args.includes('-r') } };
}

function pmRule([sub, ...args], pkg) {
  if (sub === 'list') return args[0] === 'packages' ? ALLOW : deny('pm list không được phép');
  if (![...PM_READS, ...PM_WRITES].includes(sub) || args[0] !== pkg) return deny(`pm chỉ được dùng cho ${pkg}`);
  return sub === 'clear' ? { ok: true, journal: { verb: 'clear' } } : ALLOW;
}

function bound(args, pkg) {
  const of = flag => args.filter((_, i) => args[i - 1] === flag);
  const components = [...of('-n'), ...args.filter(arg => /^[A-Za-z][\w.]*\/[\w.$]+$/.test(arg))];
  const packages = of('-p');
  if (components.some(item => !item.startsWith(`${pkg}/`)) || packages.some(item => item !== pkg)) return false;
  return components.length + packages.length > 0;
}

function amRule([sub, ...args], pkg) {
  if (['force-stop', 'kill'].includes(sub)) return args.length === 1 && args[0] === pkg ? ALLOW : deny(`am chỉ được dùng cho ${pkg}`);
  if (!['start', 'start-activity'].includes(sub)) return deny('lệnh am không được phép');
  if (args.some(arg => WEB.test(arg))) return deny('không được mở link ngoài app');
  return bound(args, pkg) ? ALLOW : deny(`am start phải chỉ rõ ${pkg}`);
}

function monkeyRule(args, pkg) {
  const packages = args.filter((_, i) => args[i - 1] === '-p');
  return packages.length === 1 && packages[0] === pkg ? ALLOW : deny(`monkey phải có -p ${pkg}`);
}

function dumpRule([what, ...args], pkg) {
  if (what === 'package') return args.length === 1 && args[0] === pkg ? ALLOW : deny(`dumpsys package chỉ cho ${pkg}`);
  return DUMPS.includes(what) ? ALLOW : deny('dumpsys không được phép');
}

const SHELL = {
  pm: pmRule, am: amRule, monkey: monkeyRule, dumpsys: dumpRule,
  getprop: () => ALLOW, date: args => (args.every(arg => arg.startsWith('+')) ? ALLOW : deny('không được đổi giờ máy')), pidof: () => ALLOW, ps: () => ALLOW,
  input: () => ALLOW, wm: args => (args.length === 1 && ['size', 'density'].includes(args[0]) ? ALLOW : deny('wm chỉ được đọc')),
  settings: args => (args[0] === 'get' ? ALLOW : deny('settings chỉ được đọc')), screencap: args => (args.join() === '-p' ? ALLOW : deny('screencap chỉ ra stdout')),
};

function shellRule(args, pkg) {
  const words = args.flatMap(arg => arg.split(' ')).filter(Boolean);
  if (words.length === 0 || !words.every(word => TOKEN.test(word))) return deny('lệnh shell có ký tự không được phép');
  const rule = Object.hasOwn(SHELL, words[0]) ? SHELL[words[0]] : null;
  return rule ? rule(words.slice(1), pkg) : deny('lệnh shell không được phép');
}

function logcatRule(args) {
  return args.some(arg => /^(?:-[a-z]*f|--file)/.test(arg)) ? deny('logcat không được ghi file') : ALLOW;
}

function judgeAdb(args, { serial, package: pkg, apks }) {
  if (args.length === 1 && args[0] === 'version') return ALLOW;
  if (args[0] === 'devices' && args.slice(1).every(arg => arg === '-l')) return { ok: true, devices: true };
  if (args[0] !== '-s' || args[1] !== serial) return deny(`chỉ được dùng -s ${serial}`);
  const [verb, ...rest] = args.slice(2);
  if (['get-state', 'wait-for-device'].includes(verb)) return rest.length === 0 ? ALLOW : deny('thừa tham số');
  if (verb === 'logcat') return logcatRule(rest);
  if (verb === 'install') return installRule(rest, { apks });
  if (verb === 'uninstall') return rest.length === 1 && rest[0] === pkg ? { ok: true, journal: { verb: 'uninstall' } } : deny(`chỉ được gỡ ${pkg}`);
  if (verb === 'exec-out') return rest.join(' ') === 'screencap -p' ? ALLOW : deny('exec-out không được phép');
  if (verb === 'shell') return shellRule(rest, pkg);
  return deny('lệnh không được phép');
}

module.exports = { judgeAdb };
