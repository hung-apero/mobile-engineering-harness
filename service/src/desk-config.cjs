const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readToken } = require('./discord-bot.cjs');
const { buildAccess, liveChannels, channelKeys } = require('../channels/access.cjs');

const CHANNELS_DIR = path.join(__dirname, '..', 'channels');
const MCP_SERVER = path.join(__dirname, 'mcp', 'server.cjs');
const PLUGIN = 'discord@claude-plugins-official';
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

function deskPaths(dzHome) {
  const dir = path.join(dzHome, 'desk');
  const state = path.join(dir, 'discord');
  return {
    dir,
    state,
    claudeDir: path.join(dir, '.claude'),
    access: path.join(state, 'access.json'),
    tokenEnv: path.join(state, '.env'),
    settings: path.join(dir, 'settings.json'),
    projectSettings: path.join(dir, '.claude', 'settings.json'),
    mcp: path.join(dir, 'mcp.json'),
    guide: path.join(dir, 'CLAUDE.md'),
    replyChannels: path.join(dir, 'reply-channels.json'),
    db: path.join(dzHome, 'dz.db'),
    tokenFile: path.join(dzHome, 'secrets', 'discord-bot-token'),
    claudeConfig: path.join(dzHome, 'claude'),
  };
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} không phải thư mục thường`);
  fs.chmodSync(dir, 0o700);
}

function sameFile(file, text) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  return Boolean(info?.isFile()) && (info.mode & 0o777) === 0o600 && fs.readFileSync(file, 'utf8') === text;
}

function writePrivate(file, text) {
  if (sameFile(file, text)) return;
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  const fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;

function buildSettings(paths, node = process.execPath) {
  const values = { NODE: node, GUARD: path.join(CHANNELS_DIR, 'reply-guard.cjs'), REPLY_CHANNELS: paths.replyChannels, DB: paths.db };
  const text = fs.readFileSync(path.join(CHANNELS_DIR, 'settings.json'), 'utf8');
  return JSON.parse(text, (_, value) => (typeof value === 'string' ? value.replace(/\{\{(\w+)\}\}/g, (all, name) => values[name] ?? all) : value));
}

const buildMcp = (dzHome, node = process.execPath) => ({ mcpServers: { dz: { command: node, args: [MCP_SERVER], env: { DZ_HOME: dzHome } } } });

function ensureDirs(dzHome) {
  const paths = deskPaths(dzHome);
  for (const dir of [paths.dir, paths.state, paths.claudeDir]) privateDir(dir);
  return paths;
}

function writeAccess(dzHome, projects, threads = []) {
  const paths = ensureDirs(dzHome);
  const live = liveChannels(projects);
  const keys = channelKeys(projects);
  const known = threads.filter(thread => Object.hasOwn(keys, thread.parent));
  const open = known.filter(thread => live.includes(thread.parent)).map(thread => thread.id);
  writePrivate(paths.replyChannels, json({ channels: [...live, ...open], keys: { ...keys, ...Object.fromEntries(known.map(thread => [thread.id, keys[thread.parent]])) } }));
  writePrivate(paths.access, json(buildAccess(projects)));
}

function prepare(dzHome, projects) {
  const paths = ensureDirs(dzHome);
  const access = buildAccess(projects);
  if (Object.keys(access.groups).length === 0) throw new Error('chưa project nào đang bật có khai kênh Discord');
  const token = readToken(paths.tokenFile);
  writeAccess(dzHome, projects);
  writePrivate(paths.tokenEnv, `DISCORD_BOT_TOKEN=${token}\n`);
  writePrivate(paths.settings, json(buildSettings(paths)));
  writePrivate(paths.projectSettings, json({ enabledPlugins: { [PLUGIN]: true } }));
  writePrivate(paths.mcp, json(buildMcp(dzHome)));
  writePrivate(paths.guide, fs.readFileSync(path.join(CHANNELS_DIR, 'CLAUDE.md'), 'utf8'));
  return paths;
}

function deskPathDirs(env, node = process.execPath) {
  const home = env.HOME || os.homedir();
  const listed = (env.PATH || '').split(':').filter(dir => path.isAbsolute(dir));
  return [...new Set([...listed, path.dirname(node), path.join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', ...SYSTEM_PATH])];
}

function deskEnv(env, dzHome) {
  const paths = deskPaths(dzHome);
  return {
    HOME: env.HOME || os.homedir(),
    USER: env.USER || os.userInfo().username,
    LOGNAME: env.LOGNAME || os.userInfo().username,
    PATH: deskPathDirs(env).join(':'),
    LANG: env.LANG || 'en_US.UTF-8',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    ...(env.TMPDIR && { TMPDIR: env.TMPDIR }),
    DZ_HOME: dzHome,
    CLAUDE_CONFIG_DIR: paths.claudeConfig,
    DISCORD_STATE_DIR: paths.state,
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  };
}

module.exports = { prepare, writeAccess, ensureDirs, deskPaths, deskEnv, deskPathDirs, buildSettings, buildMcp, PLUGIN, CHANNELS_DIR };
