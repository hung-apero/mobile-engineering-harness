const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDiscordBot, readToken, snowflakeTime, MAX_SLEEP_MS, MAX_BLOCK_MS } = require('../src/discord-bot.cjs');
const { NOW, TOKEN, CHANNEL, GUILD, PO, idAt, tempHome, tokenFileOf, json } = require('./mcp-fixtures.cjs');

const MESSAGE = idAt(NOW);

function botWith(t, responder, extra = {}) {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const sleeps = [];
  const clock = { now: NOW };
  const bot = createDiscordBot({
    tokenFile: tokenFileOf(home), now: () => clock.now,
    sleep: async ms => {
      sleeps.push(ms);
      clock.now += ms;
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responder(calls.length, url, init);
    },
    ...extra,
  });
  return { bot, calls, sleeps, clock, home };
}

test('token file must be a regular 600 file, never a symlink, and must look like a token', t => {
  const home = tempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = tokenFileOf(home);
  assert.equal(readToken(file), TOKEN);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readToken(file), { code: 'TOKEN', message: /600/ });
  fs.chmodSync(file, 0o600);
  const link = path.join(home, 'link');
  fs.symlinkSync(file, link);
  assert.throws(() => readToken(link), { code: 'TOKEN', message: /symlink/ });
  assert.throws(() => readToken(home), { code: 'TOKEN' });
  fs.writeFileSync(file, 'ngắn\nxấu');
  assert.throws(() => readToken(file), { code: 'TOKEN' });
  assert.throws(() => readToken(path.join(home, 'none')), { code: 'TOKEN' });
});

test('reads message, channel and member with the bot token and refuses redirects', async t => {
  const { bot, calls } = botWith(t, () => json({ id: MESSAGE }));
  await bot.message(CHANNEL, MESSAGE);
  await bot.channel(CHANNEL);
  await bot.member(GUILD, PO);
  assert.deepEqual(calls.map(call => call.url), [
    `https://discord.com/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`,
    `https://discord.com/api/v10/channels/${CHANNEL}`,
    `https://discord.com/api/v10/guilds/${GUILD}/members/${PO}`,
  ]);
  assert.equal(calls[0].init.headers.authorization, `Bot ${TOKEN}`);
  assert.equal(calls[0].init.redirect, 'error');
});

test('ids that are not snowflakes never reach the network', async t => {
  const { bot, calls } = botWith(t, () => json({}));
  for (const bad of ['../users/@me', '1', '', `${CHANNEL}/x`, '123456789012345678?x=1', 123456789012345678n, null]) {
    await assert.rejects(bot.message(CHANNEL, bad), { code: 'INVALID' });
    await assert.rejects(bot.member(bad, PO), { code: 'INVALID' });
  }
  assert.equal(calls.length, 0);
});

test('429 waits for Retry-After and then reads again', async t => {
  const { bot, calls, sleeps } = botWith(t, n => (n === 1 ? json({}, 429, { 'retry-after': '1.2' }) : json({ id: CHANNEL })));
  assert.equal((await bot.channel(CHANNEL)).id, CHANNEL);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1200]);
});

test('429 without a header uses retry_after of the body', async t => {
  const { bot, sleeps } = botWith(t, n => (n === 1 ? json({ retry_after: 0.5 }, 429) : json({ id: CHANNEL })));
  await bot.channel(CHANNEL);
  assert.deepEqual(sleeps, [500]);
});

test('a long Retry-After fails at once and blocks every later call without touching Discord', async t => {
  const { bot, calls, sleeps, clock } = botWith(t, n => (n === 1 ? json({}, 429, { 'retry-after': '30' }) : json({ id: CHANNEL })));
  await assert.rejects(bot.channel(CHANNEL), { code: 'RATE_LIMITED', retryAt: NOW + 30000 });
  for (let i = 0; i < 20; i += 1) await assert.rejects(bot.channel(CHANNEL), { code: 'RATE_LIMITED' });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  clock.now += 30000;
  assert.equal((await bot.channel(CHANNEL)).id, CHANNEL);
});

test('endless 429 stops after a capped number of tries, also for many parallel calls', async t => {
  const { bot, calls, sleeps } = botWith(t, () => json({}, 429, { 'retry-after': '4' }));
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => bot.channel(CHANNEL)));
  assert.ok(results.every(result => result.reason?.code === 'RATE_LIMITED'));
  assert.ok(calls.length <= 30);
  assert.ok(sleeps.every(ms => ms <= MAX_SLEEP_MS));
  assert.equal(calls.length - sleeps.length, 1);
});

test('an absurd Retry-After is capped and garbage falls back to a minute', async t => {
  const huge = botWith(t, () => json({}, 429, { 'retry-after': '1e12' }));
  await assert.rejects(huge.bot.channel(CHANNEL), { retryAt: NOW + MAX_BLOCK_MS });
  const garbage = botWith(t, () => json({}, 429, { 'retry-after': 'soon' }));
  await assert.rejects(garbage.bot.channel(CHANNEL), { retryAt: NOW + 60000 });
});

test('requests go out one at a time', async t => {
  let active = 0;
  let peak = 0;
  const { bot } = botWith(t, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
    return json({ id: CHANNEL });
  });
  await Promise.all(Array.from({ length: 5 }, () => bot.channel(CHANNEL)));
  assert.equal(peak, 1);
});

test('errors carry no token and no body text', async t => {
  const { bot } = botWith(t, n => {
    if (n === 1) throw new TypeError(`bad header Bot ${TOKEN}`);
    return json({ message: `leak ${TOKEN}` }, [0, 0, 500, 403, 401, 404][n]);
  });
  for (const code of ['DISCORD', 'DISCORD', 'FORBIDDEN', 'TOKEN', 'NOT_FOUND']) {
    const error = await bot.channel(CHANNEL).catch(value => value);
    assert.equal(error.code, code);
    assert.ok(!JSON.stringify([error.message, error.stack, { ...error }]).includes(TOKEN));
  }
});

test('dry run replies are recorded and never sent', async t => {
  const would = [];
  const { bot, calls } = botWith(t, () => json({ id: MESSAGE }), { would: item => would.push(item) });
  for (const live of [false, undefined, 'true', 1]) {
    assert.deepEqual(await bot.reply({ channelId: CHANNEL, messageId: MESSAGE, content: 'chào', live, threadName: 'x' }), { dryRun: true });
  }
  assert.equal(calls.length, 0);
  assert.equal(would.length, 4);
  assert.equal(would[0].content, 'chào');
});

test('a live reply pings nobody, is deduplicated by nonce and hides secrets', async t => {
  const { bot, calls } = botWith(t, () => json({ id: MESSAGE }));
  await bot.reply({ channelId: CHANNEL, messageId: MESSAGE, content: `@everyone ghp_${'a'.repeat(20)}`, live: true });
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(body.enforce_nonce, true);
  assert.ok(body.nonce.length <= 25);
  assert.equal(body.message_reference.message_id, MESSAGE);
  assert.ok(!body.content.includes('ghp_'));
});

test('a live reply opens the thread of the message or reuses the existing one', async t => {
  const { bot, calls } = botWith(t, n => (n === 1 ? json({ code: 160004 }, 400) : json({ id: CHANNEL })));
  const sent = await bot.reply({ channelId: CHANNEL, messageId: MESSAGE, content: 'a', live: true, threadName: 'Spec 1' });
  assert.equal(sent.channelId, MESSAGE);
  assert.ok(calls[0].url.endsWith(`/channels/${CHANNEL}/messages/${MESSAGE}/threads`));
  assert.ok(calls[1].url.endsWith(`/channels/${MESSAGE}/messages`));
  assert.equal(JSON.parse(calls[1].init.body).message_reference, undefined);
});

test('snowflakeTime matches the creation time', () => {
  assert.equal(snowflakeTime(idAt(NOW)), NOW);
});
