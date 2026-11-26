const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const int = (min, max) => ({ type: 'int', min, max });
const number = (min, max) => ({ type: 'number', min, max });

const REGISTRY = {
  P01: { every_working_hours: int(1, 168), backup_from_ping: int(0, 24), daily_after_ping: int(0, 30) },
  P02: { every_working_days: int(1, 30) },
  P03: { every_working_days: int(1, 30) },
  X01: { stop_new_at: number(0, 1) },
  X02: { silent_minutes: int(1, 1440), max_resumes: int(0, 10) },
  X05: { min_free_gb: number(0, 1000) },
  X07: { max_consecutive_failures: int(1, 20) },
  B09: { reopen_limit: int(1, 20) },
  F01: { fix_rounds: int(1, 10) },
  F07: { max_pr_lines: int(1, 100000) },
  Q03: { max_build_failures: int(1, 100) },
  Q06: { quiet_hours: int(1, 720) },
};

const LIMITS = {
  code_agents_working: int(0, 16),
  code_agents_off: int(0, 16),
  reserved_for_bug: int(0, 16),
  build: int(0, 16),
  bugs_per_project: int(0, 16),
  batch: { max_bugs: int(1, 100), max_hours: number(0.1, 168) },
};

const PROJECT_KEY = /^[A-Za-z0-9_-]+$/;

class RuleError extends Error {
  constructor(message, file, rulePath) {
    super(message);
    this.name = 'RuleError';
    this.file = file;
    this.path = rulePath;
  }
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkValue(value, spec, file, rulePath) {
  const typeOk =
    spec.type === 'bool' ? typeof value === 'boolean'
    : spec.type === 'int' ? Number.isInteger(value)
    : typeof value === 'number' && Number.isFinite(value);
  if (!typeOk) throw new RuleError(`${rulePath}: sai kiểu, cần ${spec.type}`, file, rulePath);
  if (spec.type !== 'bool' && (value < spec.min || value > spec.max)) {
    throw new RuleError(`${rulePath}: ngoài khoảng ${spec.min}..${spec.max}`, file, rulePath);
  }
}

function checkSection(section, specs, file, base) {
  if (!isPlainObject(section)) throw new RuleError(`${base}: phải là một bảng`, file, base);
  for (const [name, value] of Object.entries(section)) {
    const rulePath = `${base}.${name}`;
    if (!Object.hasOwn(specs, name)) throw new RuleError(`${rulePath}: không có trong danh sách`, file, rulePath);
    (specs[name].type ? checkValue : checkSection)(value, specs[name], file, rulePath);
  }
}

function validateDoc(doc, file, allowLimits) {
  if (doc == null) return {};
  if (!isPlainObject(doc)) throw new RuleError('tệp phải là một bảng', file, '');
  for (const key of Object.keys(doc)) {
    if (key !== 'rules' && key !== 'limits') throw new RuleError(`${key}: khóa không hợp lệ`, file, key);
  }
  if (doc.limits !== undefined) {
    if (!allowLimits) throw new RuleError('limits: suất là của cả máy, tệp dự án không được đặt', file, 'limits');
    checkSection(doc.limits, LIMITS, file, 'limits');
  }
  if (doc.rules !== undefined) {
    if (!isPlainObject(doc.rules)) throw new RuleError('rules: phải là một bảng', file, 'rules');
    for (const [code, fields] of Object.entries(doc.rules)) {
      const base = `rules.${code}`;
      if (!Object.hasOwn(REGISTRY, code)) throw new RuleError(`${base}: mã không có trong danh sách`, file, base);
      checkSection(fields, REGISTRY[code], file, base);
    }
  }
  return doc;
}

function readFile(file, required) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT' && !required) return null;
    throw new RuleError(`không đọc được tệp: ${err.message}`, file, '');
  }
}

function parse(bytes, file, allowLimits) {
  let doc;
  try {
    doc = YAML.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new RuleError(`YAML lỗi: ${err.message}`, file, '');
  }
  return validateDoc(doc, file, allowLimits);
}

function merge(base, override) {
  const rules = {};
  for (const [code, fields] of Object.entries(base.rules || {})) rules[code] = { ...fields };
  for (const [code, fields] of Object.entries(override.rules || {})) rules[code] = { ...rules[code], ...fields };
  return { rules, limits: { ...(base.limits || {}), ...(override.limits || {}) } };
}

function requireComplete(merged, file) {
  for (const [name, spec] of Object.entries(LIMITS)) {
    for (const field of spec.type ? [undefined] : Object.keys(spec)) {
      const rulePath = ['limits', name, field].filter(Boolean).join('.');
      const value = field === undefined ? merged.limits[name] : merged.limits[name]?.[field];
      if (value === undefined) throw new RuleError(`${rulePath}: thiếu`, file, rulePath);
    }
  }
  for (const [code, specs] of Object.entries(REGISTRY)) {
    if (!merged.rules[code]) throw new RuleError(`rules.${code}: thiếu`, file, `rules.${code}`);
    for (const name of Object.keys(specs)) {
      if (merged.rules[code]?.[name] === undefined) {
        throw new RuleError(`rules.${code}.${name}: thiếu`, file, `rules.${code}.${name}`);
      }
    }
  }
}

function readSources(dir, projectKey) {
  if (projectKey !== undefined && !PROJECT_KEY.test(projectKey)) {
    throw new RuleError(`tên dự án không hợp lệ: ${projectKey}`, path.join(dir, 'default.yaml'), '');
  }
  const defaultFile = path.join(dir, 'default.yaml');
  const sources = [{ file: defaultFile, bytes: readFile(defaultFile, true), allowLimits: true }];
  if (projectKey) {
    const projectFile = path.join(dir, `${projectKey}.yaml`);
    const bytes = readFile(projectFile, false);
    if (bytes) sources.push({ file: projectFile, bytes, allowLimits: false });
  }
  return sources;
}

function versionOf(sources) {
  const hash = crypto.createHash('sha256');
  for (const { bytes } of sources) hash.update(bytes);
  return hash.digest('hex').slice(0, 12);
}

function build(sources) {
  let merged = { rules: {}, limits: {} };
  for (const { file, bytes, allowLimits } of sources) merged = merge(merged, parse(bytes, file, allowLimits));
  requireComplete(merged, sources[0].file);
  return { version: versionOf(sources), rules: merged.rules, limits: merged.limits };
}

function loadRules(dir, projectKey) {
  return build(readSources(dir, projectKey));
}

function createRuleStore(dir) {
  const good = new Map();
  const errors = new Map();
  let sequence = 0;

  function get(projectKey) {
    const key = projectKey || '';
    try {
      const sources = readSources(dir, projectKey);
      const cached = good.get(key);
      const version = versionOf(sources);
      if (cached && cached.version === version) {
        errors.delete(key);
        return cached;
      }
      const loaded = build(sources);
      good.set(key, loaded);
      errors.delete(key);
      return loaded;
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      errors.set(key, { err, seq: ++sequence });
      const cached = good.get(key);
      if (cached) return cached;
      throw err;
    }
  }

  function lastError() {
    let latest = null;
    for (const entry of errors.values()) if (!latest || entry.seq > latest.seq) latest = entry;
    return latest ? latest.err : null;
  }

  return { get, lastError };
}

module.exports = { REGISTRY, LIMITS, RuleError, loadRules, createRuleStore };
