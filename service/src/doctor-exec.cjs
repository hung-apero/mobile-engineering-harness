const { spawnSync } = require('node:child_process');

const TIMEOUT_MS = 10000;

function runCommand(command, args, env, timeout = TIMEOUT_MS) {
  const out = spawnSync(command, args, {
    env, timeout, killSignal: 'SIGKILL', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024,
  });
  return {
    ok: out.status === 0 && !out.error,
    missing: out.error?.code === 'ENOENT',
    timedOut: out.error?.code === 'ETIMEDOUT',
    stdout: out.stdout ?? '',
  };
}

module.exports = { runCommand };
