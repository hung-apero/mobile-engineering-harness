const { DeskError } = require('./desk-error.cjs');
const { isHuman } = require('../inbox.cjs');
const { isSnowflake, snowflakeTime } = require('../discord-bot.cjs');

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_AHEAD_MS = 5 * 60 * 1000;
const PLAIN_TYPES = new Set([0, 19]);
const THREAD_TYPES = new Set([10, 11, 12]);
const REPLY = 0;

const refuse = message => new DeskError('REFUSED', message);

async function readOrRefuse(work, message) {
  try {
    return await work();
  } catch (error) {
    if (error?.code === 'NOT_FOUND') throw refuse(message);
    throw error;
  }
}

function channelsOfProjects(projects) {
  const map = new Map();
  for (const project of projects.values()) {
    if (!project.enabled || !project.channel) continue;
    map.set(project.channel, [...(map.get(project.channel) ?? []), project]);
  }
  return map;
}

async function readPlace({ bot, projects }, channelId) {
  const byChannel = channelsOfProjects(projects());
  if (byChannel.size === 0) throw refuse('Chưa project nào khai kênh Discord.');
  const channel = await readOrRefuse(() => bot.channel(channelId), 'Không đọc được kênh này.');
  if (channel?.id !== channelId || !isSnowflake(channel.guild_id)) throw refuse('Kênh này không thuộc server nào.');
  const inThread = THREAD_TYPES.has(channel.type);
  const home = inThread ? channel.parent_id : channelId;
  const candidates = byChannel.get(home);
  if (!candidates) throw refuse('Kênh này không thuộc project nào.');
  return { guildId: channel.guild_id, candidates, inThread };
}

function replyTarget(message, channelId) {
  const reference = message.message_reference;
  if (!reference && message.type !== 19) return null;
  const valid = reference && (reference.type ?? REPLY) === REPLY && isSnowflake(reference.message_id) && reference.channel_id === channelId;
  if (!valid) throw refuse('Tin chuyển tiếp hoặc trả lời tin ở kênh khác không được nhận.');
  return reference.message_id;
}

function checkMessage(message, { messageId, channelId, now, allowEdited }) {
  if (message?.id !== messageId || message.channel_id !== channelId) throw refuse('Tin đọc lại không khớp mã đã gửi.');
  if (!isHuman(message) || message.application_id || !isSnowflake(message.author.id)) throw refuse('Chỉ nhận tin do người gửi.');
  if (!PLAIN_TYPES.has(message.type) || message.message_snapshots?.length) throw refuse('Loại tin này không được nhận.');
  if (message.edited_timestamp !== null && message.edited_timestamp !== undefined && !allowEdited) throw refuse('Tin đã bị sửa. Hãy gửi một tin mới.');
  const age = now - snowflakeTime(messageId);
  if (age > MAX_AGE_MS) throw refuse('Tin đã quá 7 ngày. Hãy gửi một tin mới.');
  if (age < -MAX_AHEAD_MS) throw refuse('Giờ gửi của tin không hợp lệ.');
}

async function readMessage({ bot, projects }, { message_id: messageId, channel_id: channelId }, now, { allowEdited = true } = {}) {
  const place = await readPlace({ bot, projects }, channelId);
  const message = await readOrRefuse(() => bot.message(channelId, messageId), 'Không thấy tin này trong kênh.');
  checkMessage(message, { messageId, channelId, now, allowEdited });
  return { ...place, raw: message, messageId, channelId, authorId: message.author.id, text: String(message.content ?? '').trim(), replyTo: replyTarget(message, channelId) };
}

function isPo(project, member, authorId) {
  if (project.roles?.po) return member.roles.includes(project.roles.po);
  return [project.people.po, project.people.poBackup].includes(authorId);
}

async function requirePo({ bot }, { guildId, authorId }, project) {
  const member = await readOrRefuse(() => bot.member(guildId, authorId), 'Người gửi không còn trong server.');
  if (member?.user?.id !== authorId || member.user.bot || !Array.isArray(member.roles)) throw refuse('Không xác minh được người gửi.');
  if (!isPo(project, member, authorId)) throw refuse(`Người gửi không phải PO của ${project.key}.`);
}

module.exports = { readMessage, readPlace, requirePo, MAX_AGE_MS };
