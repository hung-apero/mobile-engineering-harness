const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DIR, writeJsonAtomic, codeRoot } = require('./learn-app-state.cjs');
const { readPlans, readLessons, specVersions } = require('./looper-parse.cjs');
const { readDigests, digestRel } = require('./figma-digest.cjs');

const JUDGED_STEPS = [];

function learnApp(rel) {
  return `${DIR}/${rel}`;
}

function inputPaths(root, key, state) {
  if (key === 'planning') {
    return [...readPlans(root).map(p => `plans/${p.file}`), 'app-manifest.yaml', 'scout.md', ...readDigests(root).map(d => digestRel(d.slug)), ...readLessons(root).map(l => `lessons/${l.id}.json`)].map(learnApp);
  }
  const plan = key.startsWith('review:') ? readPlans(root).find(p => p.id === key.slice('review:'.length)) : null;
  if (plan) {
    const versions = specVersions(root);
    const latest = versions[versions.length - 1];
    return [
      learnApp(`plans/${plan.file}`),
      ...plan.lessons.map(id => learnApp(`lessons/${id}.json`)),
      ...plan.screens.map(s => learnApp(digestRel(s))),
      ...(latest ? [learnApp(`inputs/spec-v${latest}.md`)] : []),
      ...((state.plans[plan.id] || {}).files || []),
    ];
  }
  throw new Error(`Không có tập file đầu vào cho ${key}`);
}

const hashCache = new Map();

function hashFile(abs) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return 'missing';
  }
  if (!stat.isFile()) return 'missing';
  const key = `${abs}:${stat.mtimeMs}:${stat.size}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  hashCache.set(key, digest);
  return digest;
}

function codeHash(root, files) {
  return crypto.createHash('sha256').update([...files].sort().map(rel => `${rel}:${hashFile(path.join(root, rel))}`).join('\n')).digest('hex');
}

function hashInputs(root, key, state) {
  const plan = (key.match(/^review:(.+)$/) || [])[1];
  const code = plan ? codeRoot(root, state, plan) : root;
  return Object.fromEntries([...new Set(inputPaths(root, key, state))].sort().map(rel => [rel, hashFile(path.join(rel.startsWith(`${DIR}/`) ? root : code, rel))]));
}

function verdictFile(root, key) {
  return path.join(root, DIR, 'verdicts', `${key.replace(/[^a-z0-9-]/gi, '_')}.json`);
}

function readVerdict(root, key) {
  const file = verdictFile(root, key);
  if (!fs.existsSync(file)) return null;
  try {
    const verdict = JSON.parse(fs.readFileSync(file, 'utf8'));
    return verdict && verdict.key === key && verdict.inputs ? verdict : { broken: true };
  } catch {
    return { broken: true };
  }
}

function writeVerdict(root, key, state, { pass, reasons, by, debt }) {
  const verdict = { key, pass, reasons, by, ...(debt ? { debt: true } : {}), at: new Date().toISOString(), inputs: hashInputs(root, key, state) };
  fs.mkdirSync(path.dirname(verdictFile(root, key)), { recursive: true });
  writeJsonAtomic(verdictFile(root, key), verdict);
  return verdict;
}

function changedInputs(now, then) {
  return [...new Set([...Object.keys(now), ...Object.keys(then)])].filter(rel => now[rel] !== then[rel]);
}

function verdictMissing(root, key, state) {
  const verdict = readVerdict(root, key);
  if (!verdict) return [`chưa được chấm (${key}) — gọi agent chấm cho bước này`];
  if (verdict.broken) return [`kết quả chấm hỏng hoặc không khớp (${key}) — chấm lại`];
  const now = hashInputs(root, key, state);
  const changed = changedInputs(now, verdict.inputs);
  if (changed.length) return [`nội dung đã đổi sau khi chấm (${key}): ${changed.join(', ')} — chấm lại`];
  if (!verdict.pass) return [`chấm không đạt (${key}): ${verdict.reasons.join('; ') || 'không ghi lý do'}`];
  return [];
}

function clearVerdicts(root, keys) {
  for (const key of keys) {
    const file = verdictFile(root, key);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

function reviewKeys(root) {
  const dir = path.join(root, DIR, 'verdicts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^review_/.test(name)).map(name => name.replace(/^review_(.*)\.json$/, 'review:$1'));
}

module.exports = { codeHash, JUDGED_STEPS, inputPaths, hashInputs, readVerdict, writeVerdict, verdictMissing, clearVerdicts, reviewKeys, verdictFile, changedInputs };
