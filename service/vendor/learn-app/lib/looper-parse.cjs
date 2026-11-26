const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');
const { AGENT_ANSWER } = require('./agent-answers.cjs');

function file(root, rel) {
  return path.join(root, DIR, rel);
}

function read(root, rel) {
  const abs = file(root, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}

function mtime(root, rel) {
  return fs.statSync(file(root, rel)).mtimeMs;
}

function specVersions(root) {
  const dir = file(root, 'inputs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(name => (name.match(/^spec-v(\d+)\.md$/) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
}

function headlessRun(root) {
  return fs.existsSync(file(root, 'inputs/headless.json'));
}

function questionBlocks(text, { agent = false } = {}) {
  return text.split(/^(?=## Q\d+\b)/m).filter(block => /^## Q\d+\b/.test(block)).map(block => ({
    id: block.match(/^## (Q\d+)/)[1],
    title: block.split('\n')[0].replace(/^##\s*/, '').trim(),
    blocking: /^## .*\[chặn\]/.test(block),
    options: (block.match(/^- [A-Z]\. /gm) || []).length,
    labels: (block.match(/^- [A-Z](?=\. )/gm) || []).map(option => option.slice(2)),
    recommended: /\*\*Đề xuất/.test(block),
    answered: /\*\*PO (trả lời|chọn)/.test(block) || (agent && AGENT_ANSWER.test(block.replace(/\r/g, ''))),
  }));
}

function openQuestions(root) {
  return questionBlocks(read(root, 'questions.md') || '', { agent: headlessRun(root) }).filter(q => !q.answered).sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

function unquote(value) {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  const inner = value.trim().replace(/^\[|\]$/g, '').trim();
  return inner ? inner.split(',').map(unquote).filter(Boolean) : [];
}

function parseFrontmatter(front) {
  const fields = {};
  let listKey = null;
  for (const line of front.replace(/\r/g, '').split('\n')) {
    const item = line.match(/^\s+-\s*(.+)$/);
    if (item && listKey) {
      fields[listKey] = [...fields[listKey], unquote(item[1])];
      continue;
    }
    const pair = line.match(/^(\w+):\s*(.*)$/);
    if (!pair) continue;
    listKey = pair[2].trim() ? null : pair[1];
    fields[pair[1]] = pair[2].trim() ? pair[2] : [];
  }
  return fields;
}

function listField(value) {
  return Array.isArray(value) ? value : parseList(value || '');
}

function readPlans(root) {
  const dir = file(root, 'plans');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.md')).sort().map(name => {
    const front = (fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r/g, '').match(/^---\n([\s\S]*?)\n---/) || [])[1];
    const fields = parseFrontmatter(front || '');
    return {
      file: name,
      id: typeof fields.id === 'string' && fields.id.trim() ? unquote(fields.id) : null,
      priority: Number(fields.priority),
      depends: listField(fields.depends),
      features: listField(fields.features),
      cases: listField(fields.cases),
      lessons: listField(fields.lessons),
      screens: listField(fields.screens),
      kb: fields.kb === undefined ? null : listField(fields.kb),
      kind: typeof fields.kind === 'string' && fields.kind.trim() ? unquote(fields.kind) : 'feature',
      touches: fields.touches === undefined ? null : listField(fields.touches).map(t => t.replace(/\\/g, '/').replace(/^\.\//, '')),
    };
  });
}

function nextPlan(plans, statuses) {
  const reviewed = id => (statuses[id] || {}).status === 'reviewed';
  return plans
    .filter(p => !reviewed(p.id) && p.depends.every(reviewed))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0] || null;
}

function hasCycle(plans) {
  const byId = Object.fromEntries(plans.map(p => [p.id, p]));
  const state = {};
  const visit = id => {
    if (state[id] === 'done') return false;
    if (state[id] === 'active') return true;
    state[id] = 'active';
    const cyclic = (byId[id] ? byId[id].depends : []).some(visit);
    state[id] = 'done';
    return cyclic;
  };
  return plans.some(p => visit(p.id));
}

function catalogFeatures(text) {
  let manifest;
  try {
    manifest = require('./manifest-yaml.cjs').parseYaml(text);
  } catch {
    return null;
  }
  const map = manifest && manifest.features;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  return Object.entries(map).map(([id, f]) => {
    const entry = f && typeof f === 'object' ? f : {};
    const app = entry.source === 'app' || (entry.catalog === 'not-in-learn-catalog' && !!entry.module);
    const inLearn = !app && entry.catalog !== 'not-in-learn-catalog';
    const artifact = entry.artifact || (entry.declared && entry.declared !== 'none' ? entry.declared : null) || (entry.artifacts ? Object.keys(entry.artifacts)[0] : null);
    return {
      id,
      ...(app ? { source: 'app', module: entry.module || null } : {}),
      catalog: inLearn ? id : null,
      catalogVersion: inLearn ? entry.catalog || null : null,
      artifact,
      version: entry.resolved || (entry.artifacts && artifact ? entry.artifacts[artifact] : null) || null,
      ...(entry.decided_by !== undefined ? { decided_by: Array.isArray(entry.decided_by) ? entry.decided_by : entry.decided_by === '' ? Object.assign([], { blockList: true }) : parseList(String(entry.decided_by)) } : {}),
    };
  });
}

function manifestFeatures(text) {
  const catalog = /^features:\s*\n\s+[^\s-]/m.test(text.replace(/\r/g, '')) ? catalogFeatures(text) : null;
  if (catalog) return catalog;
  const lines = text.replace(/\r/g, '').split('\n');
  const start = lines.findIndex(line => /^features:\s*$/.test(line));
  if (start < 0) return [];
  const features = [];
  let lastKey = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const item = line.match(/^\s*-\s*([^:]+)$/);
    const current = features[features.length - 1];
    if (item && current && lastKey && Array.isArray(current[lastKey])) {
      current[lastKey].push(unquote(item[1]));
      continue;
    }
    const match = line.match(/^\s*(-\s*)?(\w+):\s*(.*)$/);
    if (!match) continue;
    if (match[1] || !features.length) features.push({});
    lastKey = match[2];
    features[features.length - 1][lastKey] = match[3].trim() ? unquote(match[3]) : Object.assign([], { blockList: true });
  }
  return features.filter(f => f.id);
}

function manifestFeatureIds(text) {
  return manifestFeatures(text).map(f => f.id);
}

function manifestBom(text) {
  try {
    const catalog = require('./manifest-yaml.cjs').parseYaml(text).catalog;
    if (catalog && catalog['bom-pinned']) return String(catalog['bom-pinned']);
  } catch {}
  const match = text.match(/^bom:\s*(.+)$/m);
  return match ? unquote(match[1]) : null;
}

const EMPTY_PENDING = new Set(['[]', 'none', 'null', '~', '""', "''"]);

function openPending(text) {
  return [...text.matchAll(/^\s*pending:\s*(.*)$/gm)].map(m => m[1].trim()).filter(value => value && !EMPTY_PENDING.has(value));
}

// Mode is file-based (no state field): a PO who supplies inputs/from-template.json is building from a fat
// template, otherwise it is a from-scratch build. Every reuse branch keys off this (or the files it produces).
function modeOf(root) {
  return fs.existsSync(file(root, 'inputs/from-template.json')) ? 'from-template' : 'scratch';
}

function rawSpecVersion(state) {
  return state.rawSpecVersion || 1;
}

function olderThanRawSpec(root, state, rel) {
  const raw = `inputs/spec-v${rawSpecVersion(state)}.md`;
  return fs.existsSync(file(root, raw)) && fs.existsSync(file(root, rel)) && mtime(root, rel) < mtime(root, raw);
}

function planReviewReport(root, id) {
  const reports = file(root, 'reports');
  if (!fs.existsSync(reports)) return null;
  const runs = fs.readdirSync(reports).filter(name => fs.existsSync(path.join(reports, name, 'guard-result.json'))).sort().reverse();
  for (const name of runs) {
    const result = JSON.parse(fs.readFileSync(path.join(reports, name, 'guard-result.json'), 'utf8'));
    if (result.gate === 'review' && result.complete === true && (result.scope || {}).plan === id) return { dir: name, result };
  }
  return null;
}

function lessonCaseId(lessonId) {
  return `TC-${lessonId.replace('-', '')}`;
}

function readLessons(root) {
  const dir = file(root, 'lessons');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    } catch {
      return null;
    }
  }).filter(l => l && l.id && l.status === 'active');
}

function lessonApplies(lesson, manifestText) {
  const names = new Set(manifestFeatures(manifestText).flatMap(f => [f.id, f.catalog].filter(Boolean)));
  return (lesson.features || []).some(f => f === '_general' || names.has(f) || [...names].some(name => name.startsWith(`${f}-`)));
}

function planCaseIds(plan) {
  return [...plan.cases, ...(plan.lessons || []).map(lessonCaseId)];
}

module.exports = { openQuestions,
  file, read, mtime, specVersions, questionBlocks, headlessRun, readPlans, nextPlan, hasCycle,
  manifestFeatures, manifestFeatureIds, manifestBom, openPending, parseList,
  lessonCaseId, readLessons, lessonApplies, planCaseIds, rawSpecVersion, olderThanRawSpec, planReviewReport, modeOf,
};
