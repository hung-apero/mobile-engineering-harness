const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sha } = require('./token-guard.cjs');

const COOKIE = 'dz_operator';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;

const secret = () => crypto.randomBytes(32).toString('base64url');

function writeSecret(dir, token) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'web-operator-token');
  const temp = `${file}.${secret().slice(0, 8)}`;
  fs.writeFileSync(temp, `${token}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}

function cookieOf(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE && value) return value;
  }
  return null;
}

function createOperator(secretsDir, now) {
  let tokenHash = null;
  const sessions = new Map();

  return {
    issue() {
      const token = secret();
      writeSecret(secretsDir, token);
      tokenHash = sha(token);
    },
    isToken(value) {
      return tokenHash !== null && crypto.timingSafeEqual(Buffer.from(sha(value)), Buffer.from(tokenHash));
    },
    open() {
      const id = secret();
      sessions.set(sha(id), now() + SESSION_MS);
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
    },
    isSession(id) {
      return (sessions.get(sha(id)) ?? 0) > now();
    },
    cookieOf,
  };
}

module.exports = { createOperator };
