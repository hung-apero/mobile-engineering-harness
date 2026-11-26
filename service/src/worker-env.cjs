const path = require('node:path');

const LEAKING = ['LEARN_APP_DISCORD_', 'DISCORD_', 'CLAUDE_CODE_'];
const REMOVED = ['CLAUDECODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const FIXED = ['CLAUDE_CONFIG_DIR', 'BUG_FIX_STATE_DIR', 'LEARN_APP_BUILD_SLOTS'];

const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_KEY|PRIVATE_KEY|_KEY$/i;

const isLeaking = name => LEAKING.some(prefix => name.startsWith(prefix)) || REMOVED.includes(name) || SECRET.test(name);

function workerEnv(base, dzHome) {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    if (isLeaking(name)) delete env[name];
  }
  env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0';
  env.LEARN_APP_BUILD_SLOTS = '1';
  env.BUG_FIX_STATE_DIR = path.join(dzHome, 'bug-fix-state');
  if (base.DZ_CLAUDE_CONFIG === 'shared') delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = path.join(dzHome, 'claude');
  return env;
}

function applyEnv(base, overrides = {}) {
  const env = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    if (isLeaking(name) || FIXED.includes(name)) continue;
    if (value === null) delete env[name];
    else if (typeof value === 'string') env[name] = value;
    else throw new TypeError(`env ${name} phải là chuỗi hoặc null`);
  }
  return env;
}

module.exports = { workerEnv, applyEnv };
