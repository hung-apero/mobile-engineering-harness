const crypto = require('crypto');
const { read, specVersions } = require('./looper-parse.cjs');

const TYPES = ['url', 'path', 'pasted'];

function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').trim();
}

function hashText(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex');
}

function readSpecSource(root) {
  const text = read(root, 'inputs/spec-source.json');
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return { broken: true }; }
}

function validateSpecSource(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['phải là JSON object'];
  const errors = [];
  if (!TYPES.includes(obj.type)) errors.push(`type phải là ${TYPES.join('|')}`);
  if (obj.type !== 'pasted' && (typeof obj.ref !== 'string' || !obj.ref.trim())) {
    errors.push('ref: url hoặc đường dẫn nguồn spec (bỏ trống chỉ khi type: pasted)');
  }
  return errors;
}

function latestSpecText(root) {
  const versions = specVersions(root);
  if (!versions.length) return null;
  return read(root, `inputs/spec-v${versions[versions.length - 1]}.md`);
}

function specChanged(root, newText) {
  const current = latestSpecText(root);
  if (current === null) return true;
  return hashText(current) !== hashText(newText);
}

function nextSpecPath(root) {
  const versions = specVersions(root);
  const next = (versions[versions.length - 1] || 0) + 1;
  return `inputs/spec-v${next}.md`;
}

module.exports = { TYPES, normalize, hashText, readSpecSource, validateSpecSource, latestSpecText, specChanged, nextSpecPath };
