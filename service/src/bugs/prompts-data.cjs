const fs = require('node:fs');
const path = require('node:path');
const { SHA, LANE, pathsFor } = require('./git.cjs');

const KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const BATCH = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const VERSION = /^[0-9][0-9A-Za-z.-]*$/;

const bad = name => {
  throw new Error(`payload.${name} không hợp lệ`);
};

function matches(value, pattern, name) {
  return typeof value === 'string' && pattern.test(value) ? value : bad(name);
}

const checkKey = (value, name = 'keys') => matches(value, KEY, name);
const checkSha = (value, name) => matches(value, SHA, name);
const checkLane = value => matches(value, LANE, 'lanes.branch');
const checkVersion = value => matches(value, VERSION, 'version');
const checkBatch = value => matches(typeof value === 'number' ? String(value) : value, BATCH, 'batchId');

function checkList(value, name) {
  return Array.isArray(value) && value.length > 0 ? value : bad(name);
}

function checkKeys(value, project) {
  const keys = checkList(value, 'keys').map(key => checkKey(key));
  if (new Set(keys).size !== keys.length || keys.some(key => !key.startsWith(`${project.key}-`))) bad('keys');
  return keys;
}

function checkWorkDir(value, name, { dzHome, project }) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) bad(name);
  const { root } = pathsFor({ dzHome, project });
  const real = fs.realpathSync(value);
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isDirectory()) bad(name);
  return real;
}

function dataBlock(name, value) {
  const lines = (Array.isArray(value) ? value : [value]).map(item => JSON.stringify(item).replaceAll('<', '\\u003c').replaceAll('`', '\\u0060'));
  return [`<${name}>`, ...lines, `</${name}>`].join('\n');
}

function laneBranch(key, batchId) {
  return checkLane(`fix/${checkKey(key)}-${checkBatch(batchId)}`.toLowerCase());
}

module.exports = { bad, checkKey, checkSha, checkLane, checkVersion, checkBatch, checkList, checkKeys, checkWorkDir, dataBlock, laneBranch };
