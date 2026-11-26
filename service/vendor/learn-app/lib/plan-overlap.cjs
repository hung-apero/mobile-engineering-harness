const fs = require('fs');
const path = require('path');
const { hasCycle } = require('./looper-parse.cjs');

// Files every feature would otherwise edit. Only the skeleton or glue plan may touch them (when plans can run
// at the same time). A feature's own module files are not here: two plans claiming one module clash pairwise.
const HOT_FILES = [
  'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts',
  'app/build.gradle', 'app/build.gradle.kts', 'gradle/libs.versions.toml',
  'app/src/main/AndroidManifest.xml', 'app/src/main/res/values/strings.xml', 'app/src/main/res/values/themes.xml',
];
const KINDS = ['skeleton', 'feature', 'glue', 'mock-be'];
const MOCK_DIR = 'mock-be/';
const SHARED_KINDS = new Set(['skeleton', 'glue']);

function normalize(glob) {
  const clean = glob.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  return clean.endsWith('/') ? `${clean}**` : clean;
}

function literalPrefix(glob) {
  const index = glob.search(/[*?[{]/);
  return index < 0 ? glob : glob.slice(0, index);
}

function globRegex(glob) {
  const body = glob.replace(/[.+^$()|\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`^${body}$`);
}

// Conservative: two globs overlap when one literal prefix contains the other. Better a false alarm the
// planner fixes by narrowing touches than two parallel plans editing one file.
function overlaps(a, b) {
  const [x, y] = [normalize(a), normalize(b)];
  const [px, py] = [literalPrefix(x), literalPrefix(y)];
  // A plain path may be a folder: it overlaps everything under it.
  const under = (p, q) => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
  if (px === x && py === y) return under(x, y);
  if (px === x) return globRegex(y).test(x) || py.startsWith(`${x}/`);
  if (py === y) return globRegex(x).test(y) || px.startsWith(`${y}/`);
  return px.startsWith(py) || py.startsWith(px);
}

const SKIP_DIRS = new Set(['build', '.gradle', '.git', '.learn-app', 'node_modules']);

function listFiles(dir, match, depth = 0, out = []) {
  if (depth > 12 || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listFiles(full, match, depth + 1, out);
    } else if (match(entry.name)) out.push(full);
  }
  return out;
}

function relative(appRoot, file) {
  return path.relative(appRoot, file).split(path.sep).join('/');
}

function readSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function applicationFiles(appRoot) {
  if (!appRoot) return [];
  return listFiles(path.join(appRoot, 'app/src/main'), name => /\.(kt|java)$/.test(name))
    .filter(file => /:\s*[\w.]*Application\(\)|extends\s+[\w.]*Application\b/.test(readSafe(file)))
    .map(file => relative(appRoot, file));
}

// Manifests and shared values of every app source set (main, debug, flavors).
function appSourceSetFiles(appRoot) {
  if (!appRoot) return [];
  return listFiles(path.join(appRoot, 'app/src'), name => /^(AndroidManifest|strings|themes)\.xml$/.test(name))
    .map(file => relative(appRoot, file))
    .filter(rel => /^app\/src\/[^/]+\/(AndroidManifest\.xml|res\/values\/(strings|themes)\.xml)$/.test(rel));
}

function sharedFiles(appRoot) {
  return [...new Set([...HOT_FILES, ...applicationFiles(appRoot), ...appSourceSetFiles(appRoot)])];
}

function ancestors(plans) {
  const byId = Object.fromEntries(plans.map(p => [p.id, p]));
  const memo = {};
  const visit = (id, seen = new Set()) => {
    if (memo[id]) return memo[id];
    if (seen.has(id) || !byId[id]) return new Set();
    seen.add(id);
    const all = new Set();
    for (const dep of byId[id].depends) {
      all.add(dep);
      for (const up of visit(dep, seen)) all.add(up);
    }
    memo[id] = all;
    return all;
  };
  return Object.fromEntries(plans.map(p => [p.id, visit(p.id)]));
}

function overlapProblems(plans, appRoot = null) {
  if (!plans.some(p => p.touches !== null) || hasCycle(plans)) return [];
  const missing = [];
  const up = ancestors(plans);
  for (const p of plans) {
    if (!KINDS.includes(p.kind)) missing.push(`${p.id}: kind phải là ${KINDS.join('|')}`);
    if (!p.touches) missing.push(`plan ${p.id} chưa khai touches (file/thư mục plan được sửa) — plan cũ cũng phải thêm kind/touches`);
    else if (!p.touches.length) missing.push(`plan ${p.id} có touches rỗng — ghi các file/thư mục plan được sửa`);
    const odd = (p.touches || []).filter(t => /[{}"']/.test(t));
    if (odd.length) missing.push(`${p.id}: touches không dùng {…} hay dấu nháy — viết từng đường dẫn: ${odd.join(', ')}`);
  }
  for (const kind of SHARED_KINDS) {
    const found = plans.filter(p => p.kind === kind);
    if (found.length > 1) missing.push(`chỉ được một plan ${kind}, đang có: ${found.map(p => p.id).join(', ')}`);
  }
  const mocks = plans.filter(p => p.kind === 'mock-be');
  if (mocks.length > 1) missing.push(`chỉ được một plan mock-be, đang có: ${mocks.map(p => p.id).join(', ')}`);
  for (const p of mocks) {
    const outside = (p.touches || []).filter(t => !normalize(t).startsWith(MOCK_DIR));
    if (outside.length) missing.push(`${p.id}: plan mock-be chỉ sửa ${MOCK_DIR}** — bỏ ${outside.join(', ')} (wiring -PmockBe thuộc plan khung)`);
  }
  const skeleton = plans.find(p => p.kind === 'skeleton');
  if (skeleton) {
    if (skeleton.depends.length) missing.push(`plan khung ${skeleton.id} phải làm trước tiên (depends: [])`);
    const detached = plans.filter(p => p !== skeleton && !up[p.id].has(skeleton.id)).map(p => p.id);
    if (detached.length) missing.push(`plan chưa phụ thuộc plan khung ${skeleton.id}: ${detached.join(', ')}`);
  }
  const glue = plans.find(p => p.kind === 'glue');
  if (glue) {
    const early = plans.filter(p => p.kind !== 'glue' && !up[glue.id].has(p.id)).map(p => p.id);
    if (early.length) missing.push(`plan nối ${glue.id} phải làm sau cùng — thêm depends: ${early.join(', ')}`);
  }
  const hot = sharedFiles(appRoot);
  // One plan, or a straight chain, never runs beside another: it may edit shared files itself.
  const parallel = p => plans.some(o => o !== p && !up[p.id].has(o.id) && !up[o.id].has(p.id));
  for (const p of plans.filter(x => !SHARED_KINDS.has(x.kind) && x.touches && parallel(x))) {
    const hits = hot.filter(h => p.touches.some(t => overlaps(t, h)));
    if (hits.length) missing.push(`${p.id} sửa file dùng chung ${hits.join(', ')} — chuyển phần đó sang plan khung hoặc plan nối`);
  }
  const touching = plans.filter(p => p.touches && p.touches.length);
  for (let i = 0; i < touching.length; i += 1) {
    for (const b of touching.slice(i + 1)) {
      const a = touching[i];
      if (up[a.id].has(b.id) || up[b.id].has(a.id)) continue;
      const clash = a.touches.flatMap(x => b.touches.filter(y => overlaps(x, y)).map(y => (x === y ? x : `${x} ~ ${y}`)));
      if (clash.length) missing.push(`${a.id} và ${b.id} có thể chạy cùng lúc mà cùng sửa ${clash.join(', ')} — thu hẹp touches, hoặc chuyển phần chung sang plan khung/nối`);
    }
  }
  return missing;
}

function waves(plans) {
  const byId = Object.fromEntries(plans.map(p => [p.id, p]));
  const level = {};
  const depth = (id, seen = new Set()) => {
    if (level[id] !== undefined) return level[id];
    if (seen.has(id) || !byId[id]) return -1;
    seen.add(id);
    level[id] = 1 + Math.max(-1, ...byId[id].depends.map(dep => depth(dep, seen)));
    return level[id];
  };
  const out = [];
  for (const p of [...plans].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))) {
    const n = depth(p.id);
    (out[n] = out[n] || []).push(p.id);
  }
  return out.filter(Boolean);
}

module.exports = { HOT_FILES, overlaps, overlapProblems, waves, applicationFiles, sharedFiles };
