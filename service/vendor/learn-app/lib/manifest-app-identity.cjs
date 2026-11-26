const fs = require('fs');
const path = require('path');

const KEYS = { package: 'app.applicationId', version: 'app.versionName', 'version-code': 'app.versionCode' };
const DEV_PROVIDED = 'dev-provided';

function readIdentity(root) {
  const file = path.join(root, 'product.properties');
  if (!fs.existsSync(file)) return {};
  const wanted = new Set(Object.values(KEYS));
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.]+)\s*[=:]\s*(.*?)\s*$/);
    if (match && wanted.has(match[1]) && match[2]) values[match[1]] = match[2];
  }
  return values;
}

function fillAppIdentity(root, manifest) {
  const app = manifest.app;
  if (!app || typeof app !== 'object') return [];
  const open = Object.keys(KEYS).filter(key => app[key] === undefined || app[key] === '' || app[key] === DEV_PROVIDED);
  if (!open.length) return [];
  const values = readIdentity(root);
  const filled = open.filter(key => values[KEYS[key]]);
  for (const key of filled) app[key] = values[KEYS[key]];
  return filled;
}

module.exports = { fillAppIdentity };
