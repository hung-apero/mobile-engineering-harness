const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { desk, validDesk } = require('../src/desk-commands.cjs');
const { deskChecks } = require('../src/desk-doctor.cjs');
const { deskPaths, prepare } = require('../src/desk-config.cjs');
const { isWanted, setWanted, createDeskManager } = require('../src/desk.cjs');
const { runCommand } = require('../src/doctor-exec.cjs');
const { loadProjects } = require('../src/projects.cjs');
const { redact } = require('../src/redact.cjs');
const { yamlFor } = require('./projects-fixtures.cjs');
const { NOW, TOKEN, CHANNEL, project, deskHome, bin } = require('./desk-fixtures.cjs');

function setup(t, { channel = CHANNEL } = {}) {
  const h = deskHome(t);
  const projectsDir = path.join(h.home, 'projects');
  fs.mkdirSync(projectsDir);
  fs.mkdirSync(path.join(h.home, 'workspaces'));
  const doc = YAML.parse(yamlFor('AAA', h.home));
  fs.writeFileSync(path.join(projectsDir, 'AAA.yaml'), YAML.stringify({ ...doc, enabled: true, ...(channel && { channel }) }));
  bin(h.bins, 'bun', '');
  const ctx = { db: h.db, dzHome: h.home, projectsDir, env: h.env, claudeBin: h.claude, log: () => {} };
  const ready = () => {
    const paths = deskPaths(h.home);
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const installPath = path.join(paths.claudeConfig, 'plugins', 'cache');
    fs.mkdirSync(installPath, { recursive: true });
    const put = (file, value) => fs.writeFileSync(path.join(paths.claudeConfig, file), JSON.stringify(value));
    put('plugins/installed_plugins.json', { version: 2, plugins: { 'discord@claude-plugins-official': [{ scope: 'project', projectPath: paths.dir, installPath, version: '0.0.6' }] } });
    put('.claude.json', { projects: { [paths.dir]: { hasTrustDialogAccepted: true } } });
    fs.writeFileSync(path.join(h.bins, 'logged-in'), '');
    return paths;
  };
  const checks = () => Object.fromEntries(deskChecks({ dzHome: h.home, projectsDir, exec: runCommand, baseEnv: h.env, bin: h.claude }).map(check => [check.name, check]));
  const levels = () => Object.fromEntries(Object.entries(checks()).map(([name, check]) => [name, check.level]));
  return { ...h, ctx, ready, checks, levels, run: sub => desk(ctx, [sub], NOW) };
}

test('arguments: only start, stop, status, setup', () => {
  for (const sub of ['start', 'stop', 'status', 'setup']) assert.ok(validDesk([sub]));
  for (const args of [[], ['x'], ['start', 'x'], ['constructor']]) assert.ok(!validDesk(args));
});

test('setup: prints the guide with the real paths and no token', async t => {
  const h = setup(t);
  const text = (await h.run('setup')).join('\n');
  for (const part of ['Message Content Intent', 'read -rs', `${h.home}/secrets/discord-bot-token`, 'Read Message History', 'channel:', 'claude plugin install discord@claude-plugins-official --scope project']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes('{{'));
  assert.equal(redact(text), text);
  assert.equal(fs.lstatSync(deskPaths(h.home).dir).mode & 0o777, 0o700);
});

test('start: writes the config and turns the desk on for the service', async t => {
  const h = setup(t);
  const paths = h.ready();
  assert.match((await h.run('start'))[0], /Đã bật/);
  assert.equal(isWanted(h.db), true);
  assert.ok(fs.existsSync(paths.settings));
  assert.equal(h.levels()['cấu hình desk'], 'ĐẠT');
});

test('start: refuses and names what is missing', async t => {
  const h = setup(t);
  await assert.rejects(h.run('start'), /plugin discord.*tin thư mục desk/);
  assert.equal(isWanted(h.db), false);
  h.ready();
  fs.rmSync(deskPaths(h.home).tokenFile);
  await assert.rejects(h.run('start'), /token bot/);
  await assert.rejects(setup(t, { channel: null }).run('start'), /chưa project nào/);
});

test('status and stop: work without the service', async t => {
  const h = setup(t);
  h.ready();
  await h.run('start');
  assert.match((await h.run('status')).join('\n'), /bật\nPhiên: không chạy\nTin chưa ack: 0/);
  const { projects } = loadProjects(h.ctx.projectsDir, { dzHome: h.home });
  const manager = createDeskManager({ db: h.db, dzHome: h.home, bot: null, env: h.env, claudeBin: h.claude });
  const { pid } = await manager.start(projects.values(), NOW);
  assert.match((await h.run('status')).join('\n'), new RegExp(`pid ${pid}`));
  assert.deepEqual(await h.run('stop'), ['Đã tắt bàn điều phối và dừng phiên.']);
  assert.equal(isWanted(h.db), false);
  assert.match((await h.run('stop'))[0], /Không có phiên/);
});

test('doctor: one calm line when no project uses Discord', t => {
  assert.deepEqual(setup(t, { channel: null }).levels(), { desk: 'ĐẠT' });
});

test('doctor: everything missing, then everything in place', t => {
  const h = setup(t);
  const absent = h.levels();
  assert.deepEqual(absent, { tmux: 'ĐẠT', bun: 'ĐẠT', 'token bot': 'ĐẠT', 'đăng nhập desk': 'THIẾU', 'plugin discord': 'THIẾU', 'tin thư mục desk': 'THIẾU', 'cấu hình desk': 'CẢNH BÁO' });
  h.ready();
  prepare(h.home, [...loadProjects(h.ctx.projectsDir, { dzHome: h.home }).projects.values()]);
  assert.deepEqual([...new Set(Object.values(h.levels()))], ['ĐẠT']);
});

test('doctor: token problems never show the token', t => {
  const h = setup(t);
  fs.chmodSync(deskPaths(h.home).tokenFile, 0o644);
  const check = h.checks()['token bot'];
  assert.equal(check.level, 'THIẾU');
  assert.ok(!JSON.stringify(h.checks()).includes(TOKEN));
});

test('doctor: plugin or trust recorded for another folder does not count', t => {
  const h = setup(t);
  const paths = h.ready();
  for (const file of ['plugins/installed_plugins.json', '.claude.json']) {
    const target = path.join(paths.claudeConfig, file);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll(paths.dir, h.home));
  }
  assert.equal(h.levels()['plugin discord'], 'THIẾU');
  assert.equal(h.levels()['tin thư mục desk'], 'THIẾU');
});

test('doctor: loose modes and edited config are reported', t => {
  const h = setup(t);
  const paths = prepare(h.home, [...loadProjects(h.ctx.projectsDir, { dzHome: h.home }).projects.values()]);
  const settings = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  settings.permissions.allow.push('Bash');
  fs.writeFileSync(paths.settings, JSON.stringify(settings));
  assert.match(h.checks()['cấu hình desk'].detail, /settings\.json khác/);
  fs.chmodSync(paths.tokenEnv, 0o644);
  assert.match(h.checks()['cấu hình desk'].detail, /\.env phải là file thường quyền 600/);
});

test('turning the desk on is kept across managers', t => {
  const h = setup(t);
  setWanted(h.db, true, NOW);
  assert.equal(createDeskManager({ db: h.db, dzHome: h.home, bot: null, env: h.env }).status(NOW).wanted, true);
});
