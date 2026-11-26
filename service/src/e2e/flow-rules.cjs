const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const BANNED = ['runScript', 'evalScript', 'startRecording', 'assertWithAI', 'assertNoDefectsWithAI', 'extractTextWithAI'];
const APP_KEYS = ['appId', 'launchApp', 'stopApp', 'killApp', 'clearState', 'setPermissions'];
const FILE_KEYS = ['file', 'path', 'addMedia', 'takeScreenshot', 'runFlow'];
const LINK_KEYS = ['openLink', 'link'];
const EXPRESSION = /\$\{([^}]*)\}/g;
const PLAIN = /^[\w\s.'"=!&|<>+\-*/%?:,]*$/;
const WEB = /^\s*(?:https?|ftp|file|content|intent|tel|sms|smsto|mailto|javascript|data):/i;
const MAX_FILES = 2000;

class FlowError extends Error {}
const fail = message => {
  throw new FlowError(message);
};

function checkText(value) {
  for (const [, body] of value.matchAll(EXPRESSION)) if (!PLAIN.test(body)) fail('biểu thức ${…} chỉ được là biến hoặc so sánh');
  if (/\$\{[^}]*$/.test(value)) fail('biểu thức ${…} không đóng');
}

function checkPath(value, { root, dir }) {
  if (value.includes('${')) fail('đường dẫn không được chứa biểu thức');
  const full = path.resolve(dir, value);
  if (full !== root && !full.startsWith(root + path.sep)) fail('đường dẫn ra ngoài thư mục E2E');
}

function checkEntry(key, value, rule) {
  if (BANNED.includes(key)) fail(`lệnh ${key} không được phép`);
  if (APP_KEYS.includes(key) && typeof value === 'string' && value !== rule.package) fail(`chỉ được điều khiển ${rule.package}`);
  if (LINK_KEYS.includes(key) && typeof value === 'string' && (WEB.test(value) || value.includes('${'))) fail('không được mở link ngoài app');
  if (FILE_KEYS.includes(key)) for (const item of [value].flat()) if (typeof item === 'string') checkPath(item, rule);
}

function walk(node, rule) {
  if (typeof node === 'string') return checkText(node);
  if (Array.isArray(node)) return node.forEach(item => (BANNED.includes(item) ? fail(`lệnh ${item} không được phép`) : walk(item, rule)));
  if (node === null || typeof node !== 'object') return undefined;
  return Object.entries(node).forEach(([key, value]) => {
    checkText(key);
    checkEntry(key, value, rule);
    walk(value, rule);
  });
}

function checkFlow(text, { package: pkg, root, dir = root }) {
  const docs = YAML.parseAllDocuments(text, { maxAliasCount: 0 });
  const bad = docs.find(doc => doc.errors.length);
  if (bad) fail('YAML không đọc được');
  for (const doc of docs) walk(doc.toJS({ maxAliasCount: 0 }), { package: pkg, root, dir });
}

function flowFiles(root) {
  const base = path.join(root, '.maestro');
  const found = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail('.maestro không được có symlink');
      if (entry.isDirectory()) visit(file);
      else if (/\.ya?ml$/i.test(entry.name)) found.push(file);
      if (found.length > MAX_FILES) fail('.maestro có quá nhiều file');
    }
  };
  if (fs.existsSync(base)) visit(base);
  return found;
}

function checkFlows(config) {
  for (const file of flowFiles(config.root)) {
    try {
      checkFlow(fs.readFileSync(file, 'utf8'), { ...config, dir: path.dirname(file) });
    } catch (error) {
      if (!(error instanceof FlowError)) throw error;
      fail(`${path.relative(config.root, file)}: ${error.message}`);
    }
  }
}

module.exports = { checkFlow, checkFlows, FlowError };
