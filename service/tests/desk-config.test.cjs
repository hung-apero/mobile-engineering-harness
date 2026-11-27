const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepare, writeAccess, deskPaths, deskEnv, CHANNELS_DIR } = require('../src/desk-config.cjs');
const { buildAccess, liveChannels } = require('../channels/access.cjs');
const { decide } = require('../channels/reply-guard.cjs');
const { CHANNEL, ELSEWHERE, THREAD, PO, BACKUP, OTHER, TOKEN, project, deskHome } = require('./desk-fixtures.cjs');

const mode = file => fs.lstatSync(file).mode & 0o777;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const REPLY = 'mcp__plugin_discord_discord__reply';
const MSG = '900000000000000100';
const known = { channelOf: id => (id === MSG ? CHANNEL : null), others: () => [] };
const verdict = (input, channels = [CHANNEL], tool = REPLY) => decide({ tool_name: tool, tool_input: input }, { channels, keys: {} }, known).hookSpecificOutput.permissionDecision;

test('access: one entry per channel with the named people only', () => {
  const access = buildAccess([project('AAA'), project('BBB', { people: { po: '623456789012345678', qa: OTHER, devOnCall: OTHER } })]);
  assert.deepEqual(access.groups, { [CHANNEL]: { requireMention: false, allowFrom: [PO, BACKUP, OTHER, '623456789012345678'].sort() } });
  assert.deepEqual(access.allowFrom, [OTHER]);
  assert.equal(access.dmPolicy, 'allowlist');
  assert.equal(access.ackReaction, '');
});

test('access: disabled projects and projects without a channel are left out', () => {
  assert.deepEqual(buildAccess([project('AAA', { enabled: false }), project('BBB', { channel: undefined })]).groups, {});
});

test('access: a channel nobody may use is refused, never opened to everyone', () => {
  assert.throws(() => buildAccess([project('AAA', { people: {} })]), /không có người/);
});

test('access: a channel shared with a dry project is not a send channel', () => {
  assert.deepEqual(liveChannels([project('AAA', { live: true }), project('BBB')]), []);
  assert.deepEqual(liveChannels([project('AAA', { live: true }), project('BBB', { channel: ELSEWHERE })]), [CHANNEL]);
});

test('prepare: private files, token only in the channel env file', t => {
  const { home } = deskHome(t);
  const paths = prepare(home, [project('AAA', { live: true })]);
  for (const dir of [paths.dir, paths.state, paths.claudeDir]) assert.equal(mode(dir), 0o700);
  const files = [paths.access, paths.tokenEnv, paths.settings, paths.projectSettings, paths.mcp, paths.guide, paths.replyChannels];
  for (const file of files) assert.equal(mode(file), 0o600);
  assert.equal(fs.readFileSync(paths.tokenEnv, 'utf8'), `DISCORD_BOT_TOKEN=${TOKEN}\n`);
  for (const file of files.filter(item => item !== paths.tokenEnv)) assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN));
  assert.deepEqual(read(paths.replyChannels), { channels: [CHANNEL], keys: { [CHANNEL]: ['AAA'] } });
});

test('prepare: permissions allow only dz, dontAsk, guard fails closed', t => {
  const { home } = deskHome(t);
  const paths = prepare(home, [project('AAA')]);
  const settings = read(paths.settings);
  assert.deepEqual(settings.permissions.allow, ['mcp__dz__*']);
  assert.equal(settings.permissions.defaultMode, 'dontAsk');
  assert.equal(settings.permissions.denyInsteadOfPrompting, true);
  assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable');
  for (const name of ['Bash', 'Read', 'Edit', 'Write', 'Agent', 'WebFetch']) assert.ok(settings.permissions.deny.includes(name));
  const [hook] = settings.hooks.PreToolUse[0].hooks;
  assert.equal(hook.onFailure, 'block');
  assert.deepEqual([hook.command, ...hook.args], [process.execPath, path.join(CHANNELS_DIR, 'reply-guard.cjs'), paths.replyChannels, paths.db]);
  assert.ok(new RegExp(`^${settings.hooks.PreToolUse[0].matcher}$`).test(REPLY));
  assert.deepEqual(read(paths.mcp).mcpServers.dz.env, { DZ_HOME: home });
  assert.deepEqual(Object.keys(read(paths.mcp).mcpServers), ['dz']);
});

test('prepare: refuses without a channel, a token, or with a loose token file', t => {
  const { home } = deskHome(t);
  const tokenFile = deskPaths(home).tokenFile;
  assert.throws(() => prepare(home, [project('AAA', { channel: undefined })]), /chưa project nào/);
  fs.chmodSync(tokenFile, 0o644);
  assert.throws(() => prepare(home, [project('AAA')]), /quyền 600/);
  fs.rmSync(tokenFile);
  assert.throws(() => prepare(home, [project('AAA')]), /Không đọc được/);
  assert.ok(!fs.existsSync(deskPaths(home).tokenEnv));
});

test('prepare: replaces a planted symlink instead of writing through it', t => {
  const { home } = deskHome(t);
  const paths = prepare(home, [project('AAA')]);
  const outside = path.join(home, 'outside');
  fs.writeFileSync(outside, 'giữ');
  fs.rmSync(paths.tokenEnv);
  fs.symlinkSync(outside, paths.tokenEnv);
  prepare(home, [project('AAA')]);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'giữ');
  assert.ok(fs.lstatSync(paths.tokenEnv).isFile());
});

test('prepare: a symlinked state folder is refused', t => {
  const { home } = deskHome(t);
  const paths = prepare(home, [project('AAA')]);
  fs.rmSync(paths.state, { recursive: true });
  fs.symlinkSync(home, paths.state);
  assert.throws(() => prepare(home, [project('AAA')]), /không phải thư mục thường/);
});

test('reply channels: threads are added only under a live channel', t => {
  const { home } = deskHome(t);
  writeAccess(home, [project('AAA', { live: true })], [{ id: THREAD, parent: CHANNEL }, { id: ELSEWHERE, parent: PO }]);
  assert.deepEqual(read(deskPaths(home).replyChannels), { channels: [CHANNEL, THREAD], keys: { [CHANNEL]: ['AAA'], [THREAD]: ['AAA'] } });
});

test('session env: only the listed variables, no token and no webhook', t => {
  const { home, env } = deskHome(t);
  const child = deskEnv(env, home);
  assert.equal(child.CLAUDE_CONFIG_DIR, path.join(home, 'claude'));
  assert.equal(child.DISCORD_STATE_DIR, path.join(home, 'desk', 'discord'));
  assert.deepEqual(Object.keys(child).filter(name => /TOKEN|WEBHOOK|API_KEY|ANTHROPIC/.test(name)), []);
  assert.equal(deskEnv({ ...env, DZ_CLAUDE_CONFIG: 'shared' }, home).CLAUDE_CONFIG_DIR, path.join(home, 'claude'));
});

test('guard: text reply to a live channel is the only call allowed', () => {
  assert.equal(verdict({ chat_id: CHANNEL, text: 'chào', reply_to: MSG }), 'allow');
  assert.equal(verdict({ chat_id: CHANNEL, text: 'chào' }), 'deny');
  assert.equal(verdict({ chat_id: ELSEWHERE, text: 'chào', reply_to: MSG }), 'deny');
  assert.equal(verdict({ chat_id: CHANNEL, text: 'chào', reply_to: MSG }, []), 'deny');
  assert.equal(verdict({ chat_id: CHANNEL, text: 'chào', reply_to: MSG, files: ['/etc/hosts'] }), 'deny');
  assert.equal(verdict({ chat_id: CHANNEL, text: 'chào', reply_to: MSG, files: [] }), 'deny');
  assert.equal(verdict({ chat_id: [CHANNEL], text: 'chào' }), 'deny');
  assert.equal(verdict({ chat_id: CHANNEL, text: '  ', reply_to: MSG }), 'deny');
  assert.equal(verdict({ chat_id: CHANNEL, text: 'x'.repeat(1901), reply_to: MSG }), 'deny');
  assert.equal(verdict({ chat_id: CHANNEL, text: 'x', reply_to: MSG }, [CHANNEL], 'mcp__plugin_discord_discord__edit_message'), 'deny');
  assert.equal(verdict(null), 'deny');
});

test('guard: mentions and secrets are refused', () => {
  for (const text of ['@everyone', 'này @here', `<@${PO}>`, '<@&700000000000000001>', 'sk-ant-abcdef', 'https://discord.com/api/webhooks/1/x']) {
    assert.equal(verdict({ chat_id: CHANNEL, text, reply_to: MSG }), 'deny', text);
  }
});

test('guard: the command fails closed on bad input or a missing channel file', t => {
  const { home } = deskHome(t);
  const paths = prepare(home, [project('AAA', { live: true })]);
  const run = (input, file = paths.replyChannels) => spawnSync(process.execPath, [path.join(CHANNELS_DIR, 'reply-guard.cjs'), file, paths.db], { input, encoding: 'utf8' });
  const good = run(JSON.stringify({ tool_name: REPLY, tool_input: { chat_id: CHANNEL, text: 'chào' } }));
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('không phải json').status, 2);
  assert.equal(run('{}', path.join(home, 'thiếu')).status, 2);
  fs.writeFileSync(paths.replyChannels, '{}');
  assert.equal(run(JSON.stringify({ tool_name: REPLY, tool_input: {} })).status, 2);
});
