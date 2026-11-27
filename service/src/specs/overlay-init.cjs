const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const YAML = require('yaml');
const { firstLine } = require('../redact.cjs');

const SKIP = new Set(['.git', '.gradle', '.idea', '.claude', '.harness-run', '.harness-overlay', 'build', 'node_modules']);
const THEME = /\bfun\s+([A-Z][A-Za-z0-9]*)Theme\s*\(/g;
const MAX_FILES = 20000;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;

const overlayError = message => Object.assign(new Error(message), { code: 'OVERLAY' });

function themesIn(repo) {
  const found = new Set();
  const stack = [repo];
  let seen = 0;
  while (stack.length && seen < MAX_FILES) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !SKIP.has(entry.name)) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.kt') && ++seen && fs.statSync(full).size <= MAX_BYTES) {
        for (const [, name] of fs.readFileSync(full, 'utf8').matchAll(THEME)) found.add(name);
      }
    }
  }
  return [...found].sort();
}

function run(bin, args, env) {
  const base = { PATH: process.env.PATH, HOME: os.tmpdir(), LANG: 'en_US.UTF-8', CLAUDE_PY: 'python3' };
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env: { ...base, ...env }, timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(overlayError(`${path.basename(args[0] ?? bin)}: ${firstLine(stdout || stderr || error.message)}`), { exit: error.code, stdout }));
      else resolve(stdout);
    });
  });
}

async function initOverlay({ dzHome, project, repo }) {
  const home = fs.realpathSync(dzHome);
  const scripts = path.join(home, 'harness', 'skills', 'harness-init', 'scripts');
  const themes = themesIn(repo);
  if (themes.length !== 1) throw overlayError(themes.length ? `không tự tạo được overlay: code có nhiều hàm Theme (${themes.map(name => `${name}Theme`).join(', ')})` : 'không tự tạo được overlay: code app không có hàm <Tên>Theme(');
  const [prefix] = themes;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-overlay-'));
  try {
    const stackFile = path.join(work, 'stack.json');
    fs.writeFileSync(stackFile, await run('bash', [path.join(scripts, 'detect-stack.sh'), repo]));
    const yamlFile = path.join(work, 'overlay.yaml');
    await run('bash', [path.join(scripts, 'render-overlay.sh'), repo, stackFile, yamlFile], { PRODUCT_NAME: prefix, THEME_PREFIX: prefix, THEME_CLASS: `${prefix}Theme` });
    const text = fs.readFileSync(yamlFile, 'utf8');
    const doc = YAML.parse(text);
    const jsonFile = path.join(work, 'overlay.json');
    fs.writeFileSync(jsonFile, JSON.stringify(doc));
    await run('python3', ['-I', path.join(scripts, 'validate-overlay.py'), jsonFile, path.join(home, 'harness', 'overlay.schema.yaml')]).catch(error => {
      throw overlayError(`overlay tự tạo không hợp lệ: ${firstLine(error.stdout ? JSON.parse(error.stdout).errors?.join('; ') : error.message)}`);
    });
    const file = path.join(home, 'projects', `${project.key}.overlay.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { flag: 'wx', mode: 0o644 });
    return { file, product: prefix, ui: doc.stack.ui, di: doc.stack.di };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { initOverlay, themesIn };
