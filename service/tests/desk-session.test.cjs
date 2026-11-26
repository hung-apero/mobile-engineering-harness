const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const kv = require('../src/kv.cjs');
const { processStart } = require('../src/process-table.cjs');
const { createDeskSession, claudeArgs, PROMPT } = require('../src/desk-session.cjs');
const { deskPaths } = require('../src/desk-config.cjs');
const { NOW, TOKEN, project, deskHome, waitFor } = require('./desk-fixtures.cjs');

const open = h => createDeskSession({ db: h.db, dzHome: h.home, env: h.env, claudeBin: h.claude, tmuxBin: h.tmux, graceMs: 2000 });
const projects = [project('AAA')];
const isAlive = pid => processStart(pid) !== null;

test('argv is fixed: channel plugin, dontAsk, no built-in tools, no bypass, no strict mcp', () => {
  const paths = deskPaths('/x');
  assert.deepEqual(claudeArgs(paths, 'sid'), [
    '--channels', 'plugin:discord@claude-plugins-official', '--permission-mode', 'dontAsk', '--tools', '', '--setting-sources', 'project',
    '--settings', '/x/desk/settings.json', '--mcp-config', '/x/desk/mcp.json', '--disable-slash-commands', '--no-chrome', '--session-id', 'sid', '--', PROMPT,
  ]);
  assert.ok(!claudeArgs(paths, 'sid').some(arg => /dangerous|bypass|strict-mcp/.test(arg)));
});

test('start: opens tmux session dz-desk with a clean env and records pid and start time', async t => {
  const h = deskHome(t);
  const session = open(h);
  const row = await session.start(projects, NOW);
  const seen = await waitFor(() => fs.existsSync(path.join(h.bins, 'claude.json')) && JSON.parse(fs.readFileSync(path.join(h.bins, 'claude.json'), 'utf8') || 'null'));
  assert.deepEqual(seen.args, claudeArgs(deskPaths(h.home), row.sessionId));
  assert.equal(seen.cwd, deskPaths(h.home).dir);
  assert.equal(seen.env.CLAUDE_CONFIG_DIR, path.join(h.home, 'claude'));
  for (const name of ['DZ_DISCORD_WEBHOOK', 'ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN']) assert.equal(seen.env[name], undefined);
  const { args, env } = h.tmuxLog().find(call => call.args.includes('new-session'));
  assert.deepEqual(args.slice(0, 5), ['-L', 'dz-desk', '-f', '/dev/null', 'new-session']);
  assert.equal(args[args.indexOf('-s') + 1], 'dz-desk');
  assert.deepEqual(args.slice(args.indexOf('--') + 1).slice(0, 2), ['/usr/bin/env', '-i']);
  assert.ok(!JSON.stringify({ args, env }).includes(TOKEN));
  assert.equal(env.DZ_DISCORD_WEBHOOK, undefined);
  assert.deepEqual(kv.get(h.db, 'desk:session'), { sessionId: row.sessionId, pid: row.pid, pidStart: processStart(row.pid), startedAt: NOW });
});

test('start: a running session is kept, not doubled', async t => {
  const h = deskHome(t);
  const session = open(h);
  const row = await session.start(projects, NOW);
  assert.equal((await session.start(projects, NOW + 1)).pid, row.pid);
  assert.equal(h.tmuxLog().filter(call => call.args.includes('new-session')).length, 1);
});

test('start: a dz-desk session someone else opened is left alone', async t => {
  const h = deskHome(t);
  fs.writeFileSync(path.join(h.bins, 'foreign'), '');
  await assert.rejects(open(h).start(projects, NOW), /không phải do service mở/);
  assert.ok(!h.tmuxLog().some(call => call.args.includes('new-session')));
  assert.equal(open(h).current(NOW), null);
});

test('start: tmux failure and missing tools are reported', async t => {
  const h = deskHome(t);
  fs.writeFileSync(path.join(h.bins, 'broken'), '');
  await assert.rejects(open(h).start(projects, NOW), /tmux không mở được/);
  assert.equal(open(h).current(NOW).alive, false);
  const without = extra => createDeskSession({ db: h.db, dzHome: h.home, env: h.env, claudeBin: h.claude, tmuxBin: h.tmux, ...extra });
  await assert.rejects(without({ tmuxBin: '/x/tmux' }).start(projects, NOW), /không tìm thấy tmux/);
  await assert.rejects(without({ claudeBin: '/x/claude' }).start(projects, NOW), /không tìm thấy claude/);
});

test('stop: ends the recorded session and forgets it', async t => {
  const h = deskHome(t);
  const session = open(h);
  const { pid } = await session.start(projects, NOW);
  assert.equal(await session.stop(NOW), true);
  assert.equal(isAlive(pid), false);
  assert.equal(kv.get(h.db, 'desk:session'), null);
  assert.equal(await session.stop(NOW), false);
});

test('stop: never signals a process whose start time differs', async t => {
  const h = deskHome(t);
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await waitFor(() => processStart(other.pid));
  kv.set(h.db, 'desk:session', { sessionId: 's', pid: other.pid, pidStart: 'Thu Jan  1 00:00:00 1970', startedAt: NOW }, NOW);
  assert.equal(open(h).current(NOW).alive, false);
  assert.equal(await open(h).stop(NOW), false);
  assert.equal(isAlive(other.pid), true);
});

test('crash between tmux and the record: the session is found again by its id', async t => {
  const h = deskHome(t);
  const row = await open(h).start(projects, NOW);
  kv.set(h.db, 'desk:session', { sessionId: row.sessionId, pid: null, pidStart: null, startedAt: NOW }, NOW);
  await waitFor(() => fs.existsSync(path.join(h.bins, 'claude.json')));
  const found = open(h).current(NOW);
  assert.deepEqual([found.alive, found.pid], [true, row.pid]);
  assert.equal(kv.get(h.db, 'desk:session').pid, row.pid);
});
