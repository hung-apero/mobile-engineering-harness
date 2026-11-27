const { redact } = require('../redact.cjs');
const { runGit, check, pathsFor, SHA } = require('./git.cjs');

const DEFAULT_FORBIDDEN = [
  '.github/**', 'Jenkinsfile', '**/*.jks', '**/*.keystore', '**/google-services.json', '**/*service-account*.json',
  'gradle/wrapper/**', '.claude/**', 'rules/**', '**/CLAUDE.md', '**/AGENTS.md', '**/.mcp.json', '**/gradlew', '**/gradlew.bat',
];
const MAX_LINES = 1500;
const MAX_BINARY_BYTES = 1024 * 1024;
const SYMLINK = '120000';
const SUBMODULE = '160000';
const DIFF = ['--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none'];
const LITERAL = { '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' };

const globToRegExp = glob =>
  new RegExp(`^${glob.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, token => LITERAL[token] ?? `\\${token}`)}$`, 'i');

const maskAt = text => text.replaceAll('@', '#');
const hasSecret = text => redact(maskAt(text)) !== maskAt(text);
const safeFile = file => (hasSecret(file) ? redact(file) : file);

async function readChanges(git, mirror, from, to) {
  const raw = (await git(['diff', '--raw', '-z', '--no-abbrev', ...DIFF, from, to], { gitDir: mirror })).stdout.split('\0');
  const changes = new Map();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, , blob, status] = raw[i].slice(1).split(' ');
    changes.set(raw[i + 1], { file: raw[i + 1], oldMode, newMode, blob, status, added: 0, deleted: 0, binary: false });
  }
  const stat = (await git(['diff', '--numstat', '-z', ...DIFF, from, to], { gitDir: mirror })).stdout.split('\0').filter(Boolean);
  for (const row of stat) {
    const [added, deleted, ...name] = row.split('\t');
    const change = changes.get(name.join('\t'));
    if (added === '-') change.binary = true;
    else Object.assign(change, { added: Number(added), deleted: Number(deleted) });
  }
  return [...changes.values()];
}

async function addedText(git, mirror, from, to, file) {
  const { stdout } = await git(['diff', '-U0', '--submodule=short', ...DIFF, from, to, '--', `:(top,literal)${file}`], { gitDir: mirror });
  const lines = stdout.split('\n');
  const start = lines.findIndex(line => line.startsWith('@@'));
  return start === -1 ? '' : lines.slice(start).filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
}

async function checkDiff({ dzHome, project, from, to, forbidden = project.forbidden ?? [], maxLines = MAX_LINES, git = runGit }) {
  const { mirror } = pathsFor({ dzHome, project });
  check(SHA, from, 'from');
  check(SHA, to, 'to');
  const rules = [...new Set([...DEFAULT_FORBIDDEN, ...forbidden])].map(glob => ({ glob, pattern: globToRegExp(glob) }));
  const local = (project.localFiles ?? []).map(globToRegExp);
  const problems = [];
  const add = (code, file, detail, extra = {}) => problems.push({ code, file: file === null ? null : safeFile(file), detail, ...extra });
  const changes = await readChanges(git, mirror, from, to);

  for (const { file, oldMode, newMode, blob, status, added, binary } of changes) {
    const hit = rules.find(rule => rule.pattern.test(file));
    if (local.some(pattern => pattern.test(file))) add('forbidden', file, 'là file build cục bộ, không được commit', { local: true });
    else if (hit) add('forbidden', file, `nằm trong vùng cấm ${hit.glob}`);
    if (file.includes('\ufffd')) add('bad_name', file, 'tên file không phải UTF-8');
    if (hasSecret(file)) add('secret', file, 'tên file chứa bí mật');
    if (oldMode === SUBMODULE || newMode === SUBMODULE || /^\.gitmodules$/i.test(file)) add('submodule', file, 'đổi submodule');
    if (status === 'D') continue;
    if (newMode === SYMLINK) add('symlink', file, 'là symlink');
    if (binary) {
      const size = Number((await git(['cat-file', '-s', blob], { gitDir: mirror })).stdout.trim());
      if (size > MAX_BINARY_BYTES) add('big_binary', file, `file nhị phân ${size} byte, quá ${MAX_BINARY_BYTES}`);
    }
    if (added === 0) continue;
    const text = await addedText(git, mirror, from, to, file);
    if (hasSecret(text)) add('secret', file, 'dòng thêm chứa bí mật');
    if (/(?:^|\/)AndroidManifest\.xml$/i.test(file) && text.includes('<uses-permission')) add('permission', file, 'thêm uses-permission');
  }
  const lines = changes.reduce((sum, change) => sum + change.added + change.deleted, 0);
  if (lines > maxLines) add('too_large', null, `diff ${lines} dòng, quá ${maxLines}`);
  return { ok: problems.length === 0, problems, lines, files: changes.length };
}

module.exports = { checkDiff, DEFAULT_FORBIDDEN };
