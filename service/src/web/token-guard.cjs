const crypto = require('node:crypto');
const { WebError } = require('./web-error.cjs');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_BAD = 20;
const MAX_TRACKED = 2000;

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function bounded(map) {
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

function createTokenGuard(now) {
  const bad = new Map();
  const good = new Map();

  function badOf(address) {
    const entry = bad.get(address);
    if (entry && now() - entry.since < WINDOW_MS) return entry;
    bad.delete(address);
    return null;
  }

  function check(address, token, resolve) {
    const mark = sha(token);
    const entry = badOf(address);
    if (entry && entry.marks.size >= MAX_BAD && !good.has(`${address} ${mark}`)) {
      const wait = Math.ceil((entry.since + WINDOW_MS - now()) / 1000);
      throw new WebError(429, 'LIMITED', undefined, { retryAfter: Math.max(1, wait) });
    }
    const found = resolve(token);
    if (found !== null && found !== undefined && found !== false) {
      good.set(`${address} ${mark}`, true);
      bounded(good);
      return found;
    }
    if (entry) entry.marks.add(mark);
    else bad.set(address, { since: now(), marks: new Set([mark]) });
    bounded(bad);
    return null;
  }

  return { check };
}

module.exports = { createTokenGuard, sha };
