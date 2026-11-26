const fs = require('fs');
const path = require('path');
const { DIR, writeJsonAtomic } = require('./learn-app-state.cjs');

// The PO answers on Discord: the learn-app bot (LEARN_APP_DISCORD_BOT_TOKEN, read-only on the channel) reads the
// messages the PO (LEARN_APP_DISCORD_PO — nobody else counts) wrote after the harness's last question, and
// `discord-wait` hands them to the Looper, which records them as the PO's words. The channel is the webhook's.
const API = 'https://discord.com/api/v10';
// Discord refuses requests without a bot User-Agent (PowerShell's default gets 403).
const UA = 'DiscordBot (https://github.com/hung-apero/learn-app-plugin, learn-app)';
const sentFile = root => path.join(root, DIR, 'notified.json');

function readSent(root) {
  try {
    return JSON.parse(fs.readFileSync(sentFile(root), 'utf8'));
  } catch {
    return { sent: [] };
  }
}

async function getJson(url, { token, fetchImpl }) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, ...(token ? { Authorization: `Bot ${token}` } : {}) } });
  if (!res.ok) throw new Error(`Discord HTTP ${res.status} cho ${url.replace(/\/webhooks\/.*/, '/webhooks/…')}`);
  return res.json();
}

// The webhook's channel and its server (for message links).
async function channelOf(env, fetchImpl) {
  const hook = await getJson(env.LEARN_APP_DISCORD_WEBHOOK, { fetchImpl });
  return { channel: hook.channel_id, guild: hook.guild_id };
}

const newest = ids => ids.filter(Boolean).reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a), '0');

// Replies of the PO since the last one handed out (or since the harness's last message). Returns
// [{ id, text, repliedTo, link, at }] oldest first, and remembers the newest so it is never handed out twice.
async function pollReplies(root, { env = process.env, fetchImpl = fetch } = {}) {
  const token = env.LEARN_APP_DISCORD_BOT_TOKEN;
  const po = env.LEARN_APP_DISCORD_PO;
  if (!token || !po || !env.LEARN_APP_DISCORD_WEBHOOK) throw new Error('cần LEARN_APP_DISCORD_WEBHOOK, LEARN_APP_DISCORD_BOT_TOKEN và LEARN_APP_DISCORD_PO');
  const data = readSent(root);
  const after = data.lastSeen || newest((data.sent || []).map(s => s.messageId));
  const { channel, guild } = await channelOf(env, fetchImpl);
  const messages = await getJson(`${API}/channels/${channel}/messages?after=${after}&limit=50`, { token, fetchImpl });
  const replies = messages.filter(m => m.author && m.author.id === po && !m.author.bot && (m.content || '').trim())
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .map(m => ({ id: m.id, text: m.content.trim(), repliedTo: (m.message_reference || {}).message_id || null, link: `https://discord.com/channels/${guild}/${channel}/${m.id}`, at: m.timestamp }));
  const seen = newest([after, ...messages.map(m => m.id)]);
  // A failed write never loses the answers (they would only come again next time).
  if (seen !== after) try { writeJsonAtomic(sentFile(root), { ...readSent(root), lastSeen: seen }); } catch {}
  return replies;
}

// How long to wait before the next look, by how long the PO has been waited for: every 30 s for the first 15 min,
// every minute up to 30 min, every 2 min up to 60 min, then every 5 min.
const MIN = 60 * 1000;
function backoff(elapsedMs) {
  if (elapsedMs < 15 * MIN) return 30 * 1000;
  if (elapsedMs < 30 * MIN) return MIN;
  if (elapsedMs < 60 * MIN) return 2 * MIN;
  return 5 * MIN;
}

// Polls until the PO wrote something (or the time is up). intervalMs fixes the pace (tests); otherwise backoff().
async function waitReplies(root, { intervalMs = null, timeoutMs = 8 * 60 * 60 * 1000, env = process.env, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const started = now();
  const deadline = started + timeoutMs;
  for (;;) {
    try {
      const replies = await pollReplies(root, { env, fetchImpl });
      if (replies.length) return replies;
    } catch (error) {
      if (/cần LEARN_APP/.test(error.message)) throw error;
    }
    const wait = intervalMs || backoff(now() - started);
    if (now() + wait > deadline) return [];
    await sleep(wait);
  }
}

module.exports = { backoff, pollReplies, waitReplies, channelOf, UA };
