const os = require('node:os');
const { execFileSync } = require('node:child_process');

const TIMEOUT_MS = 5000;

function parseBootTime(text) {
  const match = String(text).match(/sec = (\d+), usec = (\d+)/);
  return match ? Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000) : null;
}

function bootTime({ run = execFileSync } = {}) {
  let found = null;
  try {
    found = parseBootTime(run('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
      encoding: 'utf8', timeout: TIMEOUT_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {}
  return found ?? Date.now() - os.uptime() * 1000;
}

module.exports = { bootTime, parseBootTime };
