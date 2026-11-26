const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { doctor } = require('../src/doctor.cjs');
const { FEATURE_FILES } = require('../src/bugs/workspace.cjs');
const { makeHome, writeScript, DZ } = require('./service-fixtures.cjs');
const bugsStore = require('../src/bugs/store.cjs');
const polling = require('../src/bugs/polling.cjs');
const board = require('../src/board/store.cjs');
const tokens = require('../src/board/tokens.cjs');

const PMSET = 'System-wide power settings:\n sleep 0\n autorestart 1\n';

function tools(overrides = {}) {
  const outputs = {
    claude: args => (args[0] === '--version' ? { ok: true, stdout: '2.1.332 (Claude Code)' } : { ok: true, stdout: '{"loggedIn": true, "email": "nguoi@congty.vn"}' }),
    gh: () => ({ ok: true, stdout: 'Logged in as nguoi gho_TOKEN' }),
    adb: () => ({ ok: true, stdout: 'List of devices attached\nSERIAL1\tdevice\n\n' }),
    pmset: () => ({ ok: true, stdout: PMSET }),
    maestro: () => ({ ok: true, stdout: '1.40.0' }),
    git: () => ({ ok: true, stdout: '' }),
    python3: () => ({ ok: true, stdout: '3.12\n' }),
    'sandbox-exec': () => ({ ok: true, stdout: '' }),
    security: () => ({ ok: false, stdout: '' }),
    ...overrides,
  };
  return (command, args, env) => outputs[path.basename(command)](args, env);
}

function setup(t) {
  const h = makeHome(t);
  h.env.DZ_CLAUDE_BIN = 'claude';
  fs.mkdirSync(path.join(h.dzHome, 'claude'));
  return { h, run: (overrides, extra = {}, options = {}) => doctor({ env: { ...h.env, ...extra }, exec: tools(overrides), home: h.root, codeDir: h.root, ...options }) };
}

const pinned = (h, files = FEATURE_FILES) => {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(h.dzHome, 'harness', file)), { recursive: true });
    fs.writeFileSync(path.join(h.dzHome, 'harness', file), 'x');
  }
  fs.mkdirSync(path.join(h.dzHome, 'harness', '.git'), { recursive: true });
};
const atPin = { git: args => ({ ok: true, stdout: args.includes('rev-parse') ? 'b4f5855abc\n' : '' }) };
const find = (checks, name) => checks.find(c => c.name === name);

test('everything in place: every check passes and no output is echoed', t => {
  const { h, run } = setup(t);
  h.webhook('ABC1');
  jiraFile(h, 'jira-mcp.json', WRITE_ENV);
  jiraFile(h, 'jira-read.json', READ_ENV);
  for (const [file, name] of [['confluence-read.json', 'confluence'], ['figma-read.json', 'framelink-figma']]) fs.writeFileSync(path.join(h.dzHome, 'secrets', file), JSON.stringify({ mcpServers: { [name]: { command: 'uvx' } } }), { mode: 0o600 });
  pinned(h);
  fs.mkdirSync(path.join(h.dzHome, 'android-test-harness'));
  fs.mkdirSync(path.join(h.dzHome, 'e2e'));
  fs.writeFileSync(path.join(h.dzHome, 'e2e', 'ABC1.json'), '{}');
  const checks = run({ git: args => ({ ok: true, stdout: args.includes('rev-parse') ? 'b4f5855abc\n' : '' }) });
  assert.deepEqual(checks.filter(c => c.level !== 'ĐẠT'), []);
  assert.doesNotMatch(JSON.stringify(checks), /congty|TOKEN|SERIAL1/);
});

test('each problem is reported at its level', t => {
  const { h, run } = setup(t);
  const missing = () => ({ ok: false, missing: true, stdout: '' });
  const cases = [
    ['claude', 'THIẾU', { claude: () => ({ ok: true, stdout: '2.1.331 (Claude Code)' }) }],
    ['claude', 'THIẾU', { claude: missing }],
    ['đăng nhập claude', 'THIẾU', { claude: () => ({ ok: false, stdout: '{"loggedIn": false}' }) }],
    ['đăng nhập claude', 'THIẾU', { claude: () => ({ ok: false, timedOut: true, stdout: '' }) }],
    ['gh', 'THIẾU', { gh: () => ({ ok: false, stdout: '' }) }],
    ['adb', 'THIẾU', { adb: missing }],
    ['adb', 'CẢNH BÁO', { adb: () => ({ ok: true, stdout: 'List of devices attached\nX\tunauthorized\n' }) }],
    ['máy ngủ', 'CẢNH BÁO', { pmset: () => ({ ok: true, stdout: ' sleep 1 (sleep prevented by powerd)\n autorestart 1' }) }],
    ['sandbox', 'THIẾU', { 'sandbox-exec': missing }],
    ['keychain', 'CẢNH BÁO', { security: () => ({ ok: true, stdout: '' }) }],
    ['tự bật lại', 'CẢNH BÁO', { pmset: () => ({ ok: true, stdout: ' sleep 0\n autorestart 0' }) }],
  ];
  for (const [name, level, overrides] of cases) assert.equal(find(run(overrides), name).level, level, name);
  h.webhook('ABC1');
  fs.chmodSync(path.join(h.dzHome, 'secrets', 'ABC1.discord-webhook'), 0o644);
  assert.equal(find(run(), 'file bí mật').level, 'THIẾU');
  h.project('DEF2', { repo: 'sai' });
  assert.equal(find(run(), 'project').level, 'THIẾU');
  fs.writeFileSync(path.join(h.rulesDir, 'ABC1.yaml'), 'rules:\n  Z9: {}\n');
  assert.equal(find(run(), 'rule').level, 'THIẾU');
});

test('a sandbox the operator turned off is a warning', t => {
  const { run } = setup(t);
  assert.equal(find(run({}, { DZ_SANDBOX: 'off' }), 'sandbox').level, 'CẢNH BÁO');
});

test('too little disk is reported', t => {
  const { h, run } = setup(t);
  assert.equal(find(doctor({ env: h.env, exec: tools(), freeGb: () => -1 }), 'đĩa trống').level, 'THIẾU');
  assert.equal(find(run(), 'đĩa trống').level, 'ĐẠT');
});

test('the login is checked in the folder the workers use, and the shared fallback is honoured', t => {
  const { h, run } = setup(t);
  const seen = [];
  const claude = (args, env) => {
    if (args[0] === 'auth') seen.push(env.CLAUDE_CONFIG_DIR);
    return tools()('claude', args, env);
  };
  run({ claude });
  run({ claude }, { DZ_CLAUDE_CONFIG: 'shared', CLAUDE_CONFIG_DIR: '/other' });
  assert.deepEqual(seen, [path.join(h.dzHome, 'claude'), undefined]);
});

test('dz doctor changes nothing, hides command output and exits 1 when something is missing', t => {
  const h = makeHome(t);
  const bin = path.join(h.root, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['claude', 'gh', 'adb', 'pmset']) writeScript(path.join(bin, name), 'echo "nguoi@congty.vn gho_TOKENBIMAT"; echo "LOICHITIET" >&2; exit 1');
  const env = { ...h.env, PATH: `${bin}:/usr/bin:/bin`, DZ_CLAUDE_BIN: 'claude', DZ_HOME: path.join(h.root, 'chua-co') };
  const out = spawnSync(process.execPath, [DZ, 'doctor'], { env, encoding: 'utf8' });
  assert.equal(out.status, 1);
  assert.doesNotMatch(out.stdout + out.stderr, /congty|TOKENBIMAT|LOICHITIET|\n\s+at /);
  for (const row of out.stdout.trim().split('\n')) assert.match(row, /^(ĐẠT|THIẾU|CẢNH BÁO) /);
  assert.equal(fs.existsSync(env.DZ_HOME), false);
});

test('a command that hangs is cut off', t => {
  const { runCommand } = require('../src/doctor-exec.cjs');
  const h = makeHome(t);
  const file = writeScript(path.join(h.root, 'hang'), 'exec sleep 5');
  const began = Date.now();
  const out = runCommand(file, [], process.env, 300);
  assert.equal(out.timedOut, true);
  assert.equal(out.ok, false);
  assert.ok(Date.now() - began < 3000);
});

test('service code under a folder macOS protects is a warning', t => {
  const { h, run } = setup(t);
  const codeDir = path.join(h.root, 'Desktop', 'service');
  fs.mkdirSync(codeDir, { recursive: true });
  const check = find(run({}, {}, { codeDir }), 'mã dịch vụ');
  assert.equal(check.level, 'CẢNH BÁO');
  assert.match(check.detail, /Desktop/);
  assert.equal(find(run(), 'mã dịch vụ').level, 'ĐẠT');
});

const jiraFile = (h, name, env, mode = 0o600) => {
  const file = path.join(h.dzHome, 'secrets', name);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { jira: { command: 'uvx', env } } }), { mode });
  fs.chmodSync(file, mode);
};
const WRITE_ENV = { JIRA_API_TOKEN: 'SIEUBIMAT' };
const READ_ENV = { READ_ONLY_MODE: 'true', ENABLED_TOOLS: 'jira_get_issue,jira_search,jira_get_transitions,jira_download_attachments' };

test('jira config files: missing is a warning, a loose mode or write tools in the read file is missing, values are never shown', t => {
  const { h, run } = setup(t);
  assert.equal(find(run(), 'jira ghi').level, 'CẢNH BÁO');
  assert.equal(find(run(), 'jira đọc').level, 'CẢNH BÁO');
  jiraFile(h, 'jira-mcp.json', WRITE_ENV);
  jiraFile(h, 'jira-read.json', READ_ENV);
  let checks = run();
  assert.equal(find(checks, 'jira ghi').level, 'ĐẠT');
  assert.equal(find(checks, 'jira đọc').level, 'ĐẠT');
  jiraFile(h, 'jira-mcp.json', WRITE_ENV, 0o644);
  assert.match(find(run(), 'jira ghi').detail, /600/);
  jiraFile(h, 'jira-read.json', { ...READ_ENV, ENABLED_TOOLS: 'jira_get_issue,jira_add_comment' });
  checks = run();
  assert.equal(find(checks, 'jira đọc').level, 'THIẾU');
  assert.match(find(checks, 'jira đọc').detail, /jira_add_comment/);
  jiraFile(h, 'jira-read.json', { ...READ_ENV, READ_ONLY_MODE: 'false' });
  assert.match(find(run(), 'jira đọc').detail, /READ_ONLY_MODE/);
  assert.doesNotMatch(JSON.stringify(run()), /SIEUBIMAT/);
});

test('harness: absent is a warning, a head that is not the pinned commit or a dirty tree is missing', t => {
  const { h, run } = setup(t);
  assert.equal(find(run(), 'harness').level, 'CẢNH BÁO');
  pinned(h);
  const pin = 'b4f5855';
  const at = (head, dirty = '') => run({ git: args => ({ ok: true, stdout: args.includes('rev-parse') ? head : dirty }) });
  assert.equal(find(at(`${pin}aaaa\n`), 'harness').level, 'ĐẠT');
  assert.match(find(at('c0ffee1234\n'), 'harness').detail, /lệch ghim của ABC1/);
  assert.match(find(at(`${pin}aaaa\n`, ' M skills/x\n'), 'harness').detail, /file bị sửa/);
  assert.equal(find(run({ git: () => ({ ok: false, missing: true, stdout: '' }) }), 'harness').level, 'THIẾU');
});

test('doctor reports pinned harness without headless checker', t => {
  const { h, run } = setup(t);
  pinned(h, FEATURE_FILES.filter(file => !file.endsWith('headless_check.py')));
  const check = find(run(atPin), 'harness');
  assert.equal(check.level, 'THIẾU');
  assert.match(check.detail, /headless_check\.py/);
  pinned(h);
  assert.equal(find(run(atPin), 'harness').level, 'ĐẠT');
});

test('doctor wants python3 3.9 or newer', t => {
  const { run } = setup(t);
  assert.equal(find(run({ python3: () => ({ ok: true, stdout: '3.8\n' }) }), 'python3').level, 'THIẾU');
  assert.equal(find(run({ python3: () => ({ ok: false, missing: true, stdout: '' }) }), 'python3').level, 'THIẾU');
  assert.deepEqual(find(run({ python3: () => ({ ok: true, stdout: '3.12\n' }) }), 'python3'), { level: 'ĐẠT', name: 'python3', detail: '3.12' });
});

test('doctor reports the board sync of tracked versions and live viewer links', t => {
  const { h, run } = setup(t);
  assert.match(find(run(), 'board').detail, /chưa có jira-mcp\.json/);
  jiraFile(h, 'jira-mcp.json', WRITE_ENV);
  assert.deepEqual(find(run(), 'board'), { level: 'ĐẠT', name: 'board', detail: 'không bản nào đang theo dõi; 0 link xem còn hạn' });
  const { db } = h.context();
  const now = Date.now();
  for (const version of ['1.9.2', '2.0.0']) {
    bugsStore.ensureVersion(db, { project: 'ABC1', version, now });
    polling.setPolling(db, 'ABC1', version, true, now);
  }
  board.saveSync(db, 'ABC1', '1.9.2', { at: now, ok: true, count: 3, capped: false }, now);
  tokens.issueViewer(db, { keys: [] }, now);
  tokens.revokeViewer(db, tokens.issueViewer(db, { keys: [] }, now).id, now);
  tokens.issueViewer(db, { keys: [], days: 1 }, now - 2 * 24 * 60 * 60 * 1000);
  let check = find(run(), 'board');
  assert.equal(check.level, 'CẢNH BÁO');
  assert.match(check.detail, /ABC1 1\.9\.2 đồng bộ Jira lúc \d\d:\d\d/);
  assert.match(check.detail, /ABC1 2\.0\.0 chưa đồng bộ lần nào/);
  assert.match(check.detail, /1 link xem còn hạn$/);
  board.saveSync(db, 'ABC1', '2.0.0', { at: now, ok: false, error: 'Jira 503', lastOkAt: null }, now);
  check = find(run(), 'board');
  assert.equal(check.level, 'CẢNH BÁO');
  assert.match(check.detail, /ABC1 2\.0\.0 chưa đồng bộ được: Jira 503/);
  board.saveSync(db, 'ABC1', '2.0.0', { at: now, ok: true, count: 0, capped: false }, now);
  assert.equal(find(run(), 'board').level, 'ĐẠT');
  assert.doesNotMatch(JSON.stringify(run()), /SIEUBIMAT/);
});
