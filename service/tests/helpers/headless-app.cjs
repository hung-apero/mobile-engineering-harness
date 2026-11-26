const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir, tempRepo, writeFiles } = require('./temp-git.cjs');
const S = require('../../lib/learn-app-state.cjs');
const A = require('../../lib/autopilot.cjs');

const CLI = path.resolve(__dirname, '../../bin/learn-app-state.cjs');
const HEADLESS = { LEARN_APP_HEADLESS: '1' };
const CONFIG = { spec: 'inputs/spec-v1.md', figma: null, app: 'AAP864', case: 'existing', segment: 'ask' };
const OPEN = '## Q1 · Mua gói? [chặn]\n- A. Có\n- B. Không\n- **Đề xuất: A** — x\n';

function app(step, files = {}, { config = CONFIG, g1 = 'pending', git = false } = {}) {
  const state = { ...S.newState('existing', 'AAP864'), step };
  state.gates.g1.status = g1;
  const all = {
    'state.json': JSON.stringify(state),
    'gates/approvals.md': '# Phê duyệt của PO\n',
    'inputs/spec-v1.md': 'spec',
    ...(config ? { 'inputs/headless.json': JSON.stringify(config) } : {}),
    ...files,
  };
  const named = Object.fromEntries(Object.entries(all).map(([k, v]) => [`.learn-app/${k}`, v]));
  if (git) return tempRepo(named);
  const root = tempDir('lap-headless-');
  writeFiles(root, named);
  return root;
}

function headless(fn) {
  process.env.LEARN_APP_HEADLESS = '1';
  try {
    return fn();
  } finally {
    delete process.env.LEARN_APP_HEADLESS;
  }
}

const run = (cwd, env, ...args) => spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, LEARN_APP_TRACKING: 'off', ...env } });
const segment = name => ({ config: { ...CONFIG, segment: name } });
const reason = root => A.stopReason(root, S.readState(root));
const blocked = root => JSON.parse(fs.readFileSync(path.join(root, '.learn-app/headless-blocked.json'), 'utf8'));
const hasBlocked = root => fs.existsSync(path.join(root, '.learn-app/headless-blocked.json'));

module.exports = { HEADLESS, CONFIG, OPEN, app, headless, run, segment, reason, blocked, hasBlocked };
