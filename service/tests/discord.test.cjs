const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sendDiscord } = require('../src/discord.cjs');

const URL_OK = 'https://discord.com/api/webhooks/123456/SECRET-token_abc';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dz-discord-'));
const hook = (content = URL_OK, mode = 0o600) => {
  const file = path.join(dir(), 'hook');
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
};
const NOW = 1_000_000;
const recorder = (response = () => Response.json({ id: '99' })) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetchImpl };
};
const send = (webhookFile, fetchImpl, extra = {}) =>
  sendDiscord({ webhookFile, content: 'xin chào', mentions: ['1'], fetchImpl, now: NOW, ...extra });

test('posts with wait=true, parse [], users = mentions, redirect error, content cut to 1900', async () => {
  const { calls, fetchImpl } = recorder();
  const result = await send(hook(), fetchImpl, { content: 'a'.repeat(3000) });
  assert.deepEqual(result, { ok: true, messageId: '99' });
  assert.equal(calls[0].url, `${URL_OK}?wait=true`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.content.length, 1900);
  assert.deepEqual(body.allowed_mentions, { parse: [], users: ['1'] });
});

test('cutting never leaves half a mention', async () => {
  const { calls, fetchImpl } = recorder();
  await send(hook(), fetchImpl, { content: `${'a'.repeat(1895)}<@123456789012345678>` });
  assert.equal(JSON.parse(calls[0].init.body).content, 'a'.repeat(1895));
});

test('429 uses Retry-After seconds (fractional) first, then JSON retry_after', async () => {
  let r = await send(hook(), recorder(() => new Response('{}', { status: 429, headers: { 'retry-after': '1.2' } })).fetchImpl);
  assert.equal(r.ok, false);
  assert.equal(r.retryAt, NOW + 1200);
  r = await send(hook(), recorder(() => Response.json({ retry_after: 2.5 }, { status: 429 })).fetchImpl);
  assert.equal(r.retryAt, NOW + 2500);
  r = await send(hook(), recorder(() => new Response('{}', { status: 429, headers: { 'retry-after': '86400' } })).fetchImpl);
  assert.equal(r.retryAt, NOW + 3600000);
  r = await send(hook(), recorder(() => Response.json({ retry_after: 1e12 }, { status: 429 })).fetchImpl);
  assert.equal(r.retryAt, NOW + 3600000);
});

test('other failures and network errors retry after 60 s', async () => {
  let r = await send(hook(), recorder(() => new Response('boom', { status: 500 })).fetchImpl);
  assert.deepEqual([r.ok, r.retryAt], [false, NOW + 60000]);
  r = await send(hook(), async () => {
    throw new TypeError(`fetch failed ${URL_OK}`);
  });
  assert.deepEqual([r.ok, r.retryAt], [false, NOW + 60000]);
});

test('an error message never contains the webhook URL', async () => {
  const results = [
    await send(hook(), async () => { throw new Error(URL_OK); }),
    await send(hook(), recorder(() => new Response(URL_OK, { status: 400 })).fetchImpl),
    await send(hook(URL_OK, 0o644), recorder().fetchImpl),
  ];
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.doesNotMatch(JSON.stringify(r), /SECRET|123456|discord\.com/);
  }
});

test('webhook file with mode wider than 600 is refused and nothing is sent', async () => {
  for (const mode of [0o644, 0o660, 0o604, 0o700 | 0o007]) {
    const { calls, fetchImpl } = recorder();
    const r = await send(hook(URL_OK, mode), fetchImpl);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  }
});

test('symlinked webhook file and non-discord, non-https or odd URLs are refused', async () => {
  const real = hook();
  const link = path.join(dir(), 'link');
  fs.symlinkSync(real, link);
  const bad = [
    'http://discord.com/api/webhooks/1/x',
    'https://evil.com/api/webhooks/1/x',
    'https://discord.com.evil.com/api/webhooks/1/x',
    'https://discord.com/other/1/x',
    'https://user:pw@discord.com/api/webhooks/1/x',
    'not a url',
  ];
  const { calls, fetchImpl } = recorder();
  assert.equal((await send(link, fetchImpl)).ok, false);
  for (const content of bad) assert.equal((await send(hook(content), fetchImpl)).ok, false, content);
  assert.equal((await send(path.join(dir(), 'missing'), fetchImpl)).ok, false);
  assert.equal(calls.length, 0);
  assert.equal((await send(hook('https://discordapp.com/api/webhooks/1/x\n'), fetchImpl)).ok, true);
});
