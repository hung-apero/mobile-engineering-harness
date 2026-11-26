const path = require('path');

const SECRET_NAMES = new Set(['product.properties', 'keystore.properties', 'local.properties', 'secrets.properties']);
const AI_BLOCKED_NAMES = new Set(['keystore.properties', 'local.properties', 'secrets.properties']);
const SECRET_EXT = new Set(['.jks', '.keystore', '.p12', '.pem']);
const SECRET_READ = /\b(cat|less|more|head|tail|grep|rg|sed|awk|bat|cp|base64|xxd|strings)\b[^|;&]*(\b(keystore|local|secrets)\.properties\b|\.env\b)/;

function isSecretPath(file) {
  const name = path.basename(file);
  return SECRET_NAMES.has(name) || SECRET_EXT.has(path.extname(name)) || name === '.env' || name.startsWith('.env.');
}

function isAiBlockedPath(file) {
  const name = path.basename(file);
  return AI_BLOCKED_NAMES.has(name) || SECRET_EXT.has(path.extname(name)) || name === '.env' || name.startsWith('.env.');
}

module.exports = { isSecretPath, isAiBlockedPath, SECRET_READ };
