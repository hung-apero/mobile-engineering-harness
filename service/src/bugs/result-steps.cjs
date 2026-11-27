const path = require('node:path');
const { logName } = require('../step-spec.cjs');
const { readTail } = require('./result-log.cjs');
const { redact } = require('../redact.cjs');

const LOG_LIMIT = 20 * 1024 * 1024;
const REASON_MAX = 1000;

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stepsOf(result) {
  let doc = typeof result === 'string' ? parsed(result) : result;
  if (doc && !Array.isArray(doc.steps) && typeof doc.text === 'string') doc = parsed(doc.text);
  const steps = doc?.steps;
  if (!Array.isArray(steps) || !steps.every(step => typeof step?.name === 'string' && typeof step.ok === 'boolean')) return [];
  return steps;
}

function failure(step, why) {
  const cause = step.timedOut ? 'quá giờ' : `mã thoát ${step.exitCode ?? step.signal ?? '?'}`;
  const tail = typeof step.tail === 'string' ? step.tail.trim() : '';
  return { ok: false, failedStep: step.name, reason: redact([`${step.name}: ${why ?? cause}`, tail].filter(Boolean).join('\n')).slice(0, REASON_MAX) };
}

function missingStep(steps, required) {
  const name = required.find(wanted => !steps.some(step => step.name === wanted));
  return name ? { ok: false, reason: `kết quả không có bước ${name}` } : null;
}

function normal(token) {
  const clean = token.replace(/^file:\/*/, '/').replace(/[.:,;]+$/, '');
  const located = clean.match(/^(.*?):\d+(?::\d+)?.*$/);
  return { name: (located ? located[1] : clean).replace(/^\.\//, ''), located: Boolean(located) };
}

function namesFile(token, files) {
  const { name, located } = normal(token);
  return files.some(file => file === name || name.endsWith(`/${file}`) || ((located || name.includes('/')) && file.endsWith(`/${name}`)));
}

function mentioned(text, changedFiles) {
  const bases = new Set(changedFiles.map(file => path.posix.basename(file)));
  for (const token of new Set(text.split(/[\s"'`<>()[\]{}|=,;]+/))) {
    const base = token.split('/').at(-1).split(':')[0].replace(/[.,;]+$/, '');
    if (bases.has(base) && namesFile(token, changedFiles)) return token;
  }
  return changedFiles.find(file => /[\s"'`<>()[\]{}|=,;]/.test(file) && text.includes(file)) ?? null;
}

function stepLog(dir, steps, name) {
  if (!dir) return null;
  const index = steps.findIndex(step => step.name === name);
  const tail = readTail(path.join(dir, logName(index, name)), LOG_LIMIT);
  if (!tail || tail.cut || tail.data.length >= LOG_LIMIT) return null;
  return tail.data.toString('utf8');
}

module.exports = { stepsOf, failure, missingStep, mentioned, stepLog };
