const tokens = require('./tokens.cjs');
const { boardUrl } = require('../web/links.cjs');
const { webBase } = require('../specs/kit.cjs');
const { loadedProject } = require('../commands.cjs');
const { ExpectedError } = require('../run.cjs');

const KEY = /^[A-Z][A-Z0-9]{1,19}$/;
const DAYS = /^(?:[1-9]\d?|[12]\d\d|3[0-5]\d|36[0-5])$/;
const ID = /^[1-9]\d{0,14}$/;

function parse(args) {
  const keys = [];
  let days = 90;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--days' && DAYS.test(args[i + 1] ?? '')) days = Number(args[++i]);
    else if (KEY.test(args[i])) keys.push(args[i]);
    else return null;
  }
  return new Set(keys).size === keys.length ? { keys, days } : null;
}

function validViewer([first, ...rest]) {
  if (first !== 'viewer') return false;
  if (rest[0] === '--list') return rest.length === 1;
  if (rest[0] === '--revoke') return rest.length === 2 && ID.test(rest[1]);
  return parse(rest) !== null;
}

const dayOf = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);

function list(ctx) {
  const rows = tokens.listViewers(ctx.db);
  if (!rows.length) return ['Chưa có link xem nào'];
  return rows.map(row => `#${row.id} ${row.keys.length ? row.keys.join(' ') : 'mọi project'} hết hạn ${dayOf(row.expiresAt)}${row.revoked ? ' (đã thu hồi)' : ''}`);
}

function viewer(ctx, [, ...rest], now) {
  if (rest[0] === '--list') return list(ctx);
  if (rest[0] === '--revoke') {
    if (!tokens.revokeViewer(ctx.db, Number(rest[1]), now)) throw new ExpectedError(`không có link xem #${rest[1]} còn hiệu lực`);
    return [`Đã thu hồi link xem #${rest[1]}`];
  }
  const parsed = parse(rest);
  if (!parsed) throw new ExpectedError('dùng: dz web viewer [KEY…] [--days N] | --list | --revoke <id>');
  for (const key of parsed.keys) loadedProject(ctx, key);
  const { token } = tokens.issueViewer(ctx.db, parsed, now);
  return [boardUrl(webBase(ctx), token)];
}

module.exports = { viewer, validViewer };
