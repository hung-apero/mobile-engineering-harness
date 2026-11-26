const os = require('node:os');
const { WebError } = require('./web-error.cjs');

const ANY = new Set(['0.0.0.0', '::']);
const CSP = [
  "default-src 'none'", "style-src 'self'", "script-src 'self'", "connect-src 'self'", "form-action 'self'",
  "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');

const HEADERS = {
  'content-security-policy': CSP,
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const bracket = address => (address.includes(':') ? `[${address}]` : address);

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(item => !item.internal && !item.scopeid).map(item => item.address);
}

function publicHost(bindHost) {
  if (!ANY.has(bindHost)) return bracket(bindHost);
  return bracket(lanAddresses().find(address => !address.includes(':')) ?? '127.0.0.1');
}

function allowedHosts(bindHost, port) {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  if (ANY.has(bindHost)) names.push(...lanAddresses().map(bracket));
  else names.push(bracket(bindHost));
  return new Set(names.flatMap(name => (port === 80 ? [name, `${name}:80`] : [`${name}:${port}`]).map(v => v.toLowerCase())));
}

function checkHost(req, bindHost, port) {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!allowedHosts(bindHost, port).has(host)) throw new WebError(403, 'REFUSED');
}

function checkOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  const same = req.headers.origin?.toLowerCase() === `http://${req.headers.host.toLowerCase()}`;
  if (!same || (site !== undefined && site !== 'same-origin')) throw new WebError(403, 'REFUSED');
}

module.exports = { HEADERS, checkHost, checkOrigin, publicHost };
