const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DIR } = require('./learn-app-state.cjs');
const { parseYaml, stringifyYaml } = require('./manifest-yaml.cjs');
const { validateManifest } = require('./manifest-schema.cjs');

const REPO = 'AperoVN/Tera-Learn-SDK';
const CATALOG_DIR = path.join(__dirname, '..', 'skills', 'learn-sdk-integrate', 'catalog', 'learn');

function catalogFeatureNames() {
  try {
    return fs.readdirSync(CATALOG_DIR).filter(name => fs.statSync(path.join(CATALOG_DIR, name)).isDirectory());
  } catch {
    return [];
  }
}

function catalogFile(manifest) {
  const { schema, generated, ...others } = manifest;
  return stringifyYaml({ schema: schema || '1.0.0', generated: new Date().toISOString().slice(0, 10), ...others });
}

function catalogBody(manifest, appPr, catalogNames = catalogFeatureNames()) {
  const features = Object.entries(manifest.features || {});
  const store = features.filter(([, f]) => f && f.source !== 'app' && f.catalog !== 'not-in-learn-catalog');
  const catalog = manifest.catalog || {};
  const id = (manifest.app && manifest.app.id) || 'app';
  return [
    `App manifest của ${id} trong \`feature-catalog/consumers/${id.toLowerCase()}/\`, do learn-app viết từ code app sau khi PO duyệt kết quả cuối.`,
    '',
    `Dùng ${store.length} / ${catalogNames.length} tính năng của catalog Learn.`,
    '',
    'Cần xem:',
    catalog['bom-pinned'] && catalog['bom-declared'] && catalog['bom-pinned'] !== catalog['bom-declared'] ? `- App ghim bom-pinned ${catalog['bom-pinned']}, catalog khai bom-declared ${catalog['bom-declared']}.` : null,
    ...features.filter(([, f]) => f && f.declared === 'none').map(([name, f]) => `- ${name} không khai trực tiếp — đi kèm qua ${f.via || 'phụ thuộc khác'}.`),
    ...features.filter(([, f]) => f && f.catalog === 'not-in-learn-catalog').map(([name, f]) => `- ${name} (${f.artifact || '?'}) ngoài catalog Learn.`),
    ...features.filter(([, f]) => f && f.source === 'app').map(([name, f]) => `- ${name} app tự viết (${f.module || 'module riêng'}), không lấy từ catalog.`),
    '',
    appPr ? `PR app: ${appPr}` : null,
  ].filter(line => line !== null).join('\n');
}

function run(command, args, options) {
  const out = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, ...options });
  if (out.status !== 0) throw new Error(`${command} ${args[0]}: ${`${out.stderr || out.stdout || out.error || ''}`.trim().split('\n')[0]}`);
  return out.stdout.trim();
}

function openCatalogPr(root, { appPr = null, env = process.env } = {}) {
  const file = path.join(root, DIR, 'app-manifest.yaml');
  if (!fs.existsSync(file)) return { skipped: 'chưa có app-manifest.yaml' };
  const manifest = parseYaml(fs.readFileSync(file, 'utf8'));
  if (!manifest.features || Array.isArray(manifest.features)) return { skipped: 'app-manifest.yaml còn dạng cũ — không mở PR catalog' };
  const problems = validateManifest(manifest);
  if (problems.length) return { error: `app-manifest.yaml sai định dạng, chưa mở PR catalog: ${problems.join('; ')} — spec-clear Mode: manifest viết lại theo app-manifest-schema.md rồi chạy lại handoff` };
  const id = String((manifest.app && manifest.app.id) || 'app').toLowerCase();
  const repo = env.LEARN_APP_CATALOG_REPO || REPO;
  const url = env.LEARN_APP_CATALOG_URL || `https://github.com/${repo}.git`;
  const clone = path.join(env.LEARN_APP_CATALOG_DIR || path.join(os.homedir(), '.cache', 'learn-app', 'tera-learn-sdk'), id);
  const branch = `docs/${id}-app-manifest`;
  const gitEnv = { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' };
  const git = args => run('git', ['-C', clone, ...args], { env: gitEnv });
  try {
    if (fs.existsSync(path.join(clone, '.git'))) {
      git(['remote', 'set-url', 'origin', url]);
      git(['fetch', '-q', '--depth', '1', 'origin']);
    }
    else {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      run('git', ['clone', '-q', '--depth', '1', url, clone], { env: gitEnv });
    }
    const base = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '') || 'main';
    let from = `origin/${base}`;
    try {
      git(['fetch', '-q', '--depth', '1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      from = `origin/${branch}`;
    } catch {}
    git(['checkout', '-q', '-B', branch, from]);
    const rel = path.join('feature-catalog', 'consumers', id, 'app-manifest.yaml');
    fs.mkdirSync(path.join(clone, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(clone, rel), catalogFile(manifest));
    git(['add', rel]);
    const changed = !!git(['status', '--porcelain']);
    if (changed) {
      git(['-c', 'user.name=learn-app', '-c', 'user.email=learn-app@users.noreply.github.com', 'commit', '-q', '-m', `docs(feature-catalog): ${from === `origin/${base}` ? 'add' : 'update'} ${id.toUpperCase()} app manifest`]);
      git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
    }
    const gh = env.LEARN_APP_GH || 'gh';
    const existing = spawnSync(gh, ['pr', 'view', branch, '--repo', repo, '--json', 'url,state', '-q', '.state + " " + .url'], { encoding: 'utf8', env: gitEnv });
    const [prState, prUrl] = existing.status === 0 ? existing.stdout.trim().split(/\s+/) : [];
    if (prState === 'OPEN' && prUrl) return { pr: prUrl, created: false, updated: changed };
    const pr = run(gh, ['pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--title', `docs(feature-catalog): add ${id.toUpperCase()} app manifest`, '--body', catalogBody(manifest, appPr)], { env: gitEnv });
    return { pr: pr.split('\n').pop(), created: true };
  } catch (error) {
    return { error: `PR catalog chưa mở được (${error.message}) — nhờ dev mở PR đưa .learn-app/app-manifest.yaml vào feature-catalog/consumers/${id}/ của ${repo}` };
  }
}

module.exports = { openCatalogPr, catalogFile, catalogBody };
