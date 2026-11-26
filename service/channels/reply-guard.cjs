const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { redact } = require('../src/redact.cjs');
const { scrub } = require('./private-text.cjs');

const REPLY = 'mcp__plugin_discord_discord__reply';
const FIELDS = ['chat_id', 'text', 'reply_to'];
const MAX_TEXT = 1900;
const MENTION = /@everyone|@here|<@/i;
const SNOWFLAKE = /^\d{17,20}$/;
const RECENT_MS = 7 * 24 * 3600 * 1000;
const RECENT_ROWS = 500;
const RUN = 6;
const SHORTEST = 3;

const wordsOf = text => String(text).normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function copies(text, other) {
  const said = ` ${wordsOf(text).join(' ')} `;
  const words = wordsOf(other);
  if (words.length < SHORTEST) return false;
  const size = Math.min(RUN, words.length);
  return words.slice(0, words.length - size + 1).some((_, i) => said.includes(` ${words.slice(i, i + size).join(' ')} `));
}

function otherKeys(text, chatId, keys) {
  const own = keys[chatId] ?? [];
  const foreign = Object.values(keys).flat().filter(key => !own.includes(key));
  const said = new Set(text.toUpperCase().match(/[A-Z][A-Z0-9]+/g) ?? []);
  return foreign.some(key => said.has(key));
}

function judge({ tool_name: tool, tool_input: input }, { channels, keys = {} }, inbox) {
  if (tool !== REPLY) return 'Chỉ được dùng tool reply.';
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'Tham số không hợp lệ.';
  if (Object.keys(input).some(name => !FIELDS.includes(name))) return 'Chỉ được gửi chữ, không đính kèm file.';
  if (Object.values(input).some(value => typeof value !== 'string')) return 'Tham số phải là chuỗi.';
  if (!channels.includes(input.chat_id)) return 'Kênh này đang chạy khô hoặc chưa được nhận diện nên không gửi tin.';
  if (!SNOWFLAKE.test(input.reply_to ?? '') || inbox.channelOf(input.reply_to) !== input.chat_id) return 'Phải trả lời (reply_to) đúng một tin đã nhận trong chính kênh đó.';
  if (!input.text?.trim() || input.text.length > MAX_TEXT) return 'Nội dung trống hoặc quá dài.';
  if (MENTION.test(input.text)) return 'Không được nhắc tên người hoặc nhóm.';
  if (redact(input.text) !== input.text || scrub(input.text) !== input.text) return 'Nội dung có chuỗi bí mật, link riêng hoặc địa chỉ thư.';
  if (otherKeys(input.text, input.chat_id, keys) || inbox.others(input.chat_id, keys).some(other => copies(input.text, other))) return 'Nội dung có thông tin của kênh khác.';
  return null;
}

function decide(call, config, inbox) {
  const problem = judge(call, config, inbox);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: problem ? 'deny' : 'allow',
      permissionDecisionReason: problem ?? 'đúng kênh, đúng tin, chỉ có chữ',
    },
  };
}

function inboxView(db) {
  const sameProjects = (a, b, keys) => a === b || (keys[a] !== undefined && keys[b] !== undefined && keys[a].join() === keys[b].join());
  return {
    channelOf: id => db.prepare('SELECT channel_id FROM inbox WHERE message_id = ?').get(id)?.channel_id ?? null,
    others: (chatId, keys) => db.prepare('SELECT channel_id, text FROM inbox WHERE channel_id <> ? AND seen_at >= ? ORDER BY seen_at DESC LIMIT ?').all(chatId, Date.now() - RECENT_MS, RECENT_ROWS)
      .filter(row => !sameProjects(row.channel_id, chatId, keys)).map(row => row.text),
  };
}

function main([, , channelFile, dbFile]) {
  const call = JSON.parse(fs.readFileSync(0, 'utf8'));
  const config = JSON.parse(fs.readFileSync(channelFile, 'utf8'));
  if (!Array.isArray(config.channels) || typeof config.keys !== 'object' || config.keys === null) throw new Error('danh sách kênh không hợp lệ');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    process.stdout.write(JSON.stringify(decide(call, config, inboxView(db))));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch {
    process.stderr.write('không kiểm được tin gửi, từ chối\n');
    process.exitCode = 2;
  }
}

module.exports = { decide };
