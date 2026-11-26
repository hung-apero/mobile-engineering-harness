const fs = require('node:fs');
const path = require('node:path');
const { applyEnv } = require('./worker-env.cjs');

const MAX_STEPS = 20;
const MAX_NAME = 100;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_RETRIES = 10;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

const isText = value => typeof value === 'string' && value !== '' && !value.includes('\0');
const isCount = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function check(ok, message) {
  if (!ok) throw new Error(`spec không hợp lệ: ${message}`);
}

function parseStep(step, index) {
  const at = `steps[${index}]`;
  check(isObject(step), at);
  const { name, argv, cwd, timeoutMs, retries = 0, once = false, env = {} } = step;
  check(isText(name) && name.length <= MAX_NAME, `${at}.name`);
  check(Array.isArray(argv) && isText(argv[0]) && argv.every(arg => typeof arg === 'string' && !arg.includes('\0')), `${at}.argv`);
  check(isText(cwd) && path.isAbsolute(cwd), `${at}.cwd`);
  check(isCount(timeoutMs, 1, MAX_TIMEOUT_MS), `${at}.timeoutMs`);
  check(isCount(retries, 0, MAX_RETRIES), `${at}.retries`);
  check(typeof once === 'boolean' && !(once && retries > 0), `${at}.once`);
  check(isObject(env), `${at}.env`);
  applyEnv({}, env);
  return { name, argv, cwd, timeoutMs, retries, once, env };
}

function readRegular(file) {
  const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    check(fs.fstatSync(fd).isFile(), `${file} không phải file thường`);
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readSpec(file) {
  const doc = JSON.parse(readRegular(file));
  check(isObject(doc) && Array.isArray(doc.steps) && isCount(doc.steps.length, 1, MAX_STEPS), 'steps');
  check(doc.outFile === undefined || isText(doc.outFile), 'outFile');
  const outFile = path.resolve(path.dirname(file), doc.outFile ?? 'result.json');
  check(outFile !== path.resolve(file), 'outFile');
  return { steps: doc.steps.map(parseStep), outFile };
}

function logName(index, name) {
  const clean = name.replace(/[^\w.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 60);
  return `${index}-${clean || 'step'}.log`;
}

module.exports = { readSpec, logName };
