const dns = require('node:dns');
const kv = require('./kv.cjs');
const { blockStarts, clearStartBlock } = require('./intake-state.cjs');

const OFFLINE = 'offline';
const HOST = 'api.anthropic.com';
const PROBE_MS = 5000;
const REASON = 'mất kết nối tới API Claude, chờ có mạng lại rồi chạy tiếp';

function holdOffline(db, now) {
  if (!kv.get(db, OFFLINE)) kv.set(db, OFFLINE, { since: now }, now);
  blockStarts(db, REASON, now);
}

function reachable() {
  const lookup = dns.promises.lookup(HOST);
  const timer = new Promise(resolve => setTimeout(() => resolve(false), PROBE_MS).unref());
  return Promise.race([lookup.then(() => true, () => false), timer]);
}

async function networkStep(ctx, now) {
  const held = kv.get(ctx.db, OFFLINE);
  if (!held) return;
  if (!(await (ctx.deps?.reachable ?? reachable)())) {
    blockStarts(ctx.db, REASON, now);
    return;
  }
  kv.del(ctx.db, OFFLINE);
  clearStartBlock(ctx.db);
  ctx.log('network-back', { offlineMinutes: Math.round((now - held.since) / 60000) });
}

module.exports = { holdOffline, networkStep, REASON };
