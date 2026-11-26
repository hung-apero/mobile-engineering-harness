const fs = require('fs');
const path = require('path');
const { readJson } = require('./tracking.cjs');
const { validate } = require('./json-schema-lite.cjs');

const SCHEMA_DIR = path.join(__dirname, '..', 'tracking-schema');
const BUG_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const NEW_ID = /^new-\d+$/;
const LESSON_ID = /^L-\d{3,}$/;
const SENSITIVE = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'email'],
  [/\b(ghp|gho|ghs|github_pat|xox[baprs]|AKIA|AIza|sk-)[\w-]{8,}/, 'token'],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}/, 'JWT'],
  [/\b[0-9a-f]{32,}\b/i, 'chuỗi hex dài (khóa/id thiết bị)'],
];
const LIMITS = { summary: 300, rootCause: 500, symptom: 500, cause: 500, rule: 400, title: 160 };

function schema(name) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8'));
}

function jsonFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.json') && !n.startsWith('_')).sort() : [];
}

function textProblems(label, value) {
  const text = JSON.stringify(value);
  const problems = SENSITIVE.filter(([pattern]) => pattern.test(text)).map(([, what]) => `${label}: có ${what} — bỏ đi, chỉ giữ tóm tắt kỹ thuật`);
  for (const [field, max] of Object.entries(LIMITS)) {
    if (typeof value[field] === 'string' && value[field].length > max) problems.push(`${label}: ${field} dài quá ${max} ký tự`);
  }
  return problems;
}

function readOut(outDir, app, knownLessonIds) {
  const load = sub => jsonFiles(path.join(outDir, sub)).map(name => ({ name, data: readJson(path.join(outDir, sub, name), null) }));
  const bugs = load('bugs');
  const lessons = load('lessons');
  const meta = readJson(path.join(outDir, '_meta.json'), null);
  const newIds = new Set(lessons.map(l => l.data && l.data.id).filter(id => NEW_ID.test(id || '')));
  const errors = [];
  if (!meta || typeof meta.complete !== 'boolean') errors.push('_meta.json: cần { "complete": true|false, "total": <số bug Jira trả về> }');
  for (const { name, data } of bugs) {
    if (!data) { errors.push(`bugs/${name}: JSON hỏng`); continue; }
    errors.push(...validate(schema('bug.schema.json'), data).map(e => `bugs/${name}: ${e}`), ...textProblems(`bugs/${name}`, data));
    if (!BUG_KEY.test(data.key || '')) errors.push(`bugs/${name}: key "${data.key}" không phải mã Jira`);
    if (data.app !== app) errors.push(`bugs/${name}: app ${data.app} khác ${app}`);
    if (data.lessonId && !newIds.has(data.lessonId) && !knownLessonIds.has(data.lessonId)) errors.push(`bugs/${name}: lessonId ${data.lessonId} không có`);
  }
  for (const { name, data } of lessons) {
    if (!data) { errors.push(`lessons/${name}: JSON hỏng`); continue; }
    errors.push(...validate(schema('lesson.schema.json'), data).map(e => `lessons/${name}: ${e}`), ...textProblems(`lessons/${name}`, data));
    if (!NEW_ID.test(data.id || '') && !(LESSON_ID.test(data.id || '') && knownLessonIds.has(data.id))) errors.push(`lessons/${name}: id "${data.id}" phải là new-<n> hoặc một bài học đã có`);
    if (Array.isArray(data.features) && !data.features.length) errors.push(`lessons/${name}: cần ít nhất một feature (hoặc _general)`);
    if (data.level === 'block' && !data.cause) errors.push(`lessons/${name}: level block cần nguyên nhân (cause)`);
  }
  return { bugs, lessons, meta, errors };
}

module.exports = { readOut, jsonFiles, schema, LESSON_ID };
