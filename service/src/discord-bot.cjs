const fs = require('node:fs');
const { redact } = require('./redact.cjs');
const { MAX_CONTENT } = require('./discord.cjs');

const API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://localhost/dev-zone, 1)';
const TIMEOUT_MS = 15000;
const ATTEMPTS = 3;
const MAX_SLEEP_MS = 5000;
const MAX_BLOCK_MS = 3600 * 1000;
const DEFAULT_BLOCK_MS = 60000;
const TOKEN = /^[\w.-]{50,120}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const DISCORD_EPOCH = 1420070400000n;
const THREAD_EXISTS = 160004;

class BotError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BotError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const isSnowflake = value => typeof value === 'string' && SNOWFLAKE.test(value);
const snowflakeTime = id => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

function checkId(...ids) {
  if (!ids.every(isSnowflake)) throw new BotError('INVALID', 'Mã Discord không hợp lệ');
}

function readToken(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    throw new BotError('TOKEN', error.code === 'ELOOP' ? 'File token bot không được là symlink' : 'Không đọc được file token bot');
  }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) throw new BotError('TOKEN', 'File token bot không phải file thường');
    if (info.mode & 0o077) throw new BotError('TOKEN', 'File token bot phải có quyền 600');
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!TOKEN.test(token)) throw new BotError('TOKEN', 'Nội dung file token bot không đúng dạng');
    return token;
  } finally {
    fs.closeSync(fd);
  }
}

function retryMs(response, body) {
  const header = response.headers.get('retry-after');
  const seconds = header?.trim() ? Number(header) : Number(body?.retry_after ?? NaN);
  const ms = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : DEFAULT_BLOCK_MS;
  return Math.min(ms, MAX_BLOCK_MS);
}

function failure(status, body) {
  const extra = { status, discordCode: body?.code };
  if (status === 404) return new BotError('NOT_FOUND', 'Discord không có mục này', extra);
  if (status === 401) return new BotError('TOKEN', 'Discord từ chối token bot', extra);
  if (status === 403) return new BotError('FORBIDDEN', 'Bot không có quyền đọc hoặc gửi ở đây', extra);
  return new BotError('DISCORD', `Discord trả về HTTP ${status}`, extra);
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createDiscordBot({ tokenFile, fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now, sleep = defaultSleep, would = () => {} }) {
  let blockedUntil = 0;
  let tail = Promise.resolve();

  const limited = () => new BotError('RATE_LIMITED', 'Discord đang giới hạn tần suất, hãy thử lại sau', { retryAt: blockedUntil });

  async function waitTurn() {
    const wait = blockedUntil - now();
    if (wait <= 0) return;
    if (wait > MAX_SLEEP_MS) throw limited();
    await sleep(wait);
  }

  async function once(method, route, body) {
    const headers = { authorization: `Bot ${readToken(tokenFile)}`, 'user-agent': USER_AGENT };
    if (body) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${API}${route}`, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), ...(body && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new BotError('DISCORD', `Không gọi được Discord: ${error?.name ?? 'lỗi mạng'}`);
    }
    const data = await response.json().catch(() => null);
    return { response, data };
  }

  async function run(method, route, body) {
    for (let attempt = 1; ; attempt += 1) {
      await waitTurn();
      const { response, data } = await once(method, route, body);
      if (response.ok) {
        if (data === null) throw new BotError('DISCORD', 'Discord trả về nội dung không đọc được');
        return data;
      }
      if (response.status !== 429) throw failure(response.status, data);
      blockedUntil = Math.max(blockedUntil, now() + retryMs(response, data));
      if (attempt >= ATTEMPTS) throw limited();
    }
  }

  function request(method, route, body) {
    const result = tail.then(() => run(method, route, body));
    tail = result.catch(() => {});
    return result;
  }

  async function message(channelId, messageId) {
    checkId(channelId, messageId);
    return request('GET', `/channels/${channelId}/messages/${messageId}`);
  }

  async function channel(channelId) {
    checkId(channelId);
    return request('GET', `/channels/${channelId}`);
  }

  async function member(guildId, userId) {
    checkId(guildId, userId);
    return request('GET', `/guilds/${guildId}/members/${userId}`);
  }

  async function messagesAfter(channelId, after = null, limit = 100) {
    checkId(channelId, ...(after === null ? [] : [after]));
    const list = await request('GET', `/channels/${channelId}/messages?limit=${limit}${after === null ? '' : `&after=${after}`}`);
    if (!Array.isArray(list)) throw new BotError('DISCORD', 'Discord trả về danh sách tin không đúng dạng');
    return list;
  }

  async function activeThreads(guildId) {
    checkId(guildId);
    const { threads } = await request('GET', `/guilds/${guildId}/threads/active`);
    if (!Array.isArray(threads)) throw new BotError('DISCORD', 'Discord trả về danh sách thread không đúng dạng');
    return threads;
  }

  async function openThread(channelId, messageId, name) {
    try {
      return String((await request('POST', `/channels/${channelId}/messages/${messageId}/threads`, { name: redact(name).slice(0, 90), auto_archive_duration: 10080 })).id);
    } catch (error) {
      if (error.discordCode === THREAD_EXISTS) return messageId;
      throw error;
    }
  }

  async function reply({ channelId, messageId, content, live, threadName = null }) {
    checkId(channelId, messageId);
    const text = redact(content).slice(0, MAX_CONTENT);
    if (live !== true) {
      would({ channelId, messageId, content: text, threadName });
      return { dryRun: true };
    }
    const target = threadName === null ? channelId : await openThread(channelId, messageId, threadName);
    const sent = await request('POST', `/channels/${target}/messages`, {
      content: text,
      allowed_mentions: { parse: [], replied_user: false },
      nonce: `dz${messageId}`,
      enforce_nonce: true,
      ...(target === channelId && { message_reference: { message_id: messageId, fail_if_not_exists: false } }),
    });
    return { messageId: String(sent.id), channelId: target };
  }

  return { message, channel, member, messagesAfter, activeThreads, reply };
}

module.exports = { createDiscordBot, readToken, isSnowflake, snowflakeTime, BotError, MAX_SLEEP_MS, MAX_BLOCK_MS };
