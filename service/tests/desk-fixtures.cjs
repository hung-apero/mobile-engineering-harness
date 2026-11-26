const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');
const f = require('./mcp-fixtures.cjs');

const TMUX = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const home = __dirname;
const note = file => home + '/' + file;
const alive = () => { try { process.kill(Number(fs.readFileSync(note('tmux.pid'), 'utf8')), 0); return true; } catch { return false; } };
fs.appendFileSync(note('tmux.log'), JSON.stringify({ args, env: process.env }) + '\\n');
if (args.includes('has-session')) process.exit(fs.existsSync(note('foreign')) || alive() ? 0 : 1);
if (fs.existsSync(note('broken'))) process.exit(1);
const [command, ...rest] = args.slice(args.indexOf('--') + 1);
const cwd = args[args.indexOf('-c') + 1];
const child = spawn(command, rest, { cwd, detached: true, stdio: 'ignore' });
fs.writeFileSync(note('tmux.pid'), String(child.pid));
fs.writeFileSync(note('pids'), (fs.existsSync(note('pids')) ? fs.readFileSync(note('pids'), 'utf8') : '') + child.pid + '\\n');
process.stdout.write(child.pid + '\\n');
child.unref();
`;

const CLAUDE = `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: fs.existsSync(__dirname + '/logged-in') })); process.exit(0); }
fs.writeFileSync(__dirname + '/claude.json', JSON.stringify({ args, env: process.env, cwd: process.cwd() }));
setInterval(() => {}, 1000);
`;

function bin(dir, name, source) {
  fs.writeFileSync(path.join(dir, `${name}.cjs`), source);
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, `${name}.cjs`)}" "$@"\n`, { mode: 0o755 });
  return file;
}

function deskHome(t) {
  const home = fs.realpathSync(f.tempHome());
  fs.chmodSync(home, 0o700);
  const bins = path.join(home, 'bins');
  fs.mkdirSync(bins);
  const tmux = bin(bins, 'tmux', TMUX);
  const claude = bin(bins, 'claude', CLAUDE);
  const db = openDb(path.join(home, 'dz.db'));
  const env = { HOME: path.join(home, 'user'), USER: 'dz', LOGNAME: 'dz', PATH: `${bins}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', LEARN_APP_DISCORD_WEBHOOK: 'x', ANTHROPIC_API_KEY: 'y', DISCORD_BOT_TOKEN: 'z' };
  t.after(() => {
    db.close();
    const pids = path.join(bins, 'pids');
    for (const pid of fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number) : []) try { process.kill(-pid, 'SIGKILL'); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  });
  const tmuxLog = () => fs.readFileSync(path.join(bins, 'tmux.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { home, bins, tmux, claude, db, env, tmuxLog };
}

async function waitFor(check) {
  for (let i = 0; i < 400; i += 1) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('quá giờ chờ');
}

const message = (id, extra = {}) => ({ id, type: 0, author: { id: f.PO }, content: 'chào', ...extra });

module.exports = { ...f, deskHome, waitFor, message, bin };
