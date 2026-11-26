const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');

const SCHEMA = 1;

function trackingDir(root) {
  return path.join(root, DIR, 'tracking');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonl(root, name, entry) {
  try {
    const dir = trackingDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, name), `${JSON.stringify(entry)}\n`);
  } catch {}
}

function readJsonl(root, name) {
  try {
    return fs.readFileSync(path.join(trackingDir(root), name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

module.exports = { trackingDir, readJson, appendJsonl, readJsonl, SCHEMA };
