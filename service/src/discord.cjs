const fs = require('node:fs');
const { redact } = require('./redact.cjs');

const MAX_CONTENT = 1900;
const TIMEOUT_MS = 15000;
const MAX_RETRY_MS = 3600 * 1000;
const DEFAULT_RETRY_MS = 60000;
const HOSTS = new Set(['discord.com', 'discordapp.com']);

class WebhookFileError extends Error {}

function readWebhookUrl(file) {
  let info;
  try {
    info = fs.lstatSync(file);
  } catch {
    throw new WebhookFileError('không đọc được file webhook');
  }
  if (info.isSymbolicLink()) throw new WebhookFileError('file webhook không được là symlink');
  if (!info.isFile()) throw new WebhookFileError('file webhook không phải file thường');
  if (info.mode & 0o077) throw new WebhookFileError('file webhook phải có quyền 600');
  let url;
  try {
    url = new URL(fs.readFileSync(file, 'utf8').trim());
  } catch {
    throw new WebhookFileError('nội dung file webhook không phải URL');
  }
  const valid =
    url.protocol === 'https:' &&
    HOSTS.has(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.startsWith('/api/webhooks/');
  if (!valid) throw new WebhookFileError('file webhook không phải URL webhook Discord');
  url.search = '';
  url.hash = '';
  url.searchParams.set('wait', 'true');
  return url;
}

function cutContent(content) {
  if (content.length <= MAX_CONTENT) return content;
  let cut = content.slice(0, MAX_CONTENT);
  const open = cut.lastIndexOf('<');
  if (open > cut.lastIndexOf('>')) cut = cut.slice(0, open);
  return cut;
}

const after = (now, seconds) => now + Math.min(Math.ceil(seconds * 1000), MAX_RETRY_MS);

function retryFromResponse(response, body, now) {
  const raw = response.headers.get('retry-after');
  const header = raw === null || raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(header) && header >= 0) return after(now, header);
  const fromBody = body && typeof body.retry_after === 'number' ? body.retry_after : NaN;
  if (Number.isFinite(fromBody) && fromBody >= 0) return after(now, fromBody);
  return now + DEFAULT_RETRY_MS;
}

async function sendDiscord({ webhookFile, content, mentions = [], fetchImpl = globalThis.fetch, now = Date.now() }) {
  const fallback = now + DEFAULT_RETRY_MS;
  let url;
  try {
    url = readWebhookUrl(webhookFile);
  } catch (err) {
    return { ok: false, retryAt: fallback, error: err instanceof WebhookFileError ? err.message : 'không đọc được file webhook' };
  }
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: cutContent(redact(content)),
        allowed_mentions: { parse: [], users: mentions },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, retryAt: fallback, error: `gửi Discord thất bại: ${err && err.name ? err.name : 'lỗi mạng'}` };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) {
    const messageId = body && body.id !== undefined ? String(body.id) : undefined;
    const channelId = body && body.channel_id !== undefined ? String(body.channel_id) : undefined;
    return messageId === undefined ? { ok: true } : { ok: true, messageId, ...(channelId !== undefined && { channelId }) };
  }
  return { ok: false, retryAt: retryFromResponse(response, body, now), error: `Discord trả về HTTP ${response.status}` };
}

module.exports = { sendDiscord, MAX_CONTENT };
