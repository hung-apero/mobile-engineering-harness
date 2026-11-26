const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { checkMockDir } = require('./mock-be-contract.cjs');
const { DEFAULT_PORT } = require('../templates/mock-be/server.cjs');
const pluginVersion = require('./plugin-version.cjs');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'mock-be', 'server.cjs');
const PROBE_TIMEOUT_MS = 10000;

function install(appRoot, version = pluginVersion.current() || 'dev') {
  const target = path.join(appRoot, 'mock-be', 'server.cjs');
  const content = fs.readFileSync(TEMPLATE, 'utf8').replace('__VERSION__', version);
  const changed = !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content;
  if (changed) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return { installed: path.relative(appRoot, target), version, changed };
}

function check(appRoot) {
  return checkMockDir(path.join(appRoot, 'mock-be'));
}

const EMPTY_KEYS = ['data', 'items', 'screens'];

function knownEmpty(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== 'object') return false;
  const lists = EMPTY_KEYS.filter(key => key in value);
  return lists.length > 0 && lists.every(key => Array.isArray(value[key]) && value[key].length === 0);
}

function classifyProbe(status, text) {
  if (status < 200 || status >= 300) return 'unreachable';
  try {
    return knownEmpty(JSON.parse(text)) ? 'empty' : 'has-content';
  } catch {
    return 'unreachable';
  }
}

function screensUrl(cms) {
  return new URL('v1/tera-learning/screens', cms.endsWith('/') ? cms : `${cms}/`).toString();
}

async function probe({ harnessRoot, bundle, cms, fetchImpl = fetch, now = () => new Date() }) {
  const url = screensUrl(cms);
  let result;
  try {
    const response = await fetchImpl(url, { headers: { 'x-api-bundleid': bundle }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const text = await response.text();
    result = { cms: classifyProbe(response.status, text), httpStatus: response.status };
  } catch (error) {
    result = { cms: 'unreachable', error: error.message };
  }
  const record = { ...result, bundle, url, checkedAt: now().toISOString() };
  const file = path.join(harnessRoot, '.learn-app', 'backend-probe.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function adbReverse(port) {
  const run = spawnSync('adb', ['reverse', `tcp:${port}`, `tcp:${port}`], { encoding: 'utf8' });
  if (run.error || run.status !== 0) {
    console.error(`Cảnh báo: chưa chạy được adb reverse tcp:${port} tcp:${port} (${run.error ? 'không có adb' : (run.stderr || '').trim() || 'không có thiết bị'}). App trên máy sẽ không gọi được mock tới khi chạy lệnh đó.`);
    return false;
  }
  return true;
}

function serve(appRoot, port = DEFAULT_PORT) {
  const server = path.join(appRoot, 'mock-be', 'server.cjs');
  if (!fs.existsSync(server)) throw new Error(`Chưa có ${path.relative(appRoot, server)} — chạy mock-be.cjs install trước.`);
  adbReverse(port);
  return spawn(process.execPath, [server, '--port', String(port)], { stdio: 'inherit' });
}

module.exports = { install, check, classifyProbe, screensUrl, probe, adbReverse, serve };
