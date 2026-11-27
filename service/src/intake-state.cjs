const kv = require('./kv.cjs');
const { intake } = require('./health.cjs');
const { loadQuota, quotaUntil, heldUntil } = require('./quota.cjs');

const BLOCK = 'start-block';
const BLOCK_MS = 5 * 60 * 1000;

function blockStarts(db, error, now) {
  kv.set(db, BLOCK, { until: now + BLOCK_MS, error }, now);
}

function startBlock(db, now) {
  const block = kv.get(db, BLOCK);
  return block && now < block.until ? block : null;
}

function clearStartBlock(db) {
  kv.del(db, BLOCK);
}

function intakeState(ctx, rules, now) {
  const freeGb = ctx.freeGb(ctx.dzHome);
  const disk = intake({ freeGb, rules, now }).code === 'X05' ? { lowDisk: true } : {};
  const block = startBlock(ctx.db, now);
  if (block) return { open: false, code: 'X08', until: block.until, ...disk };
  const quota = loadQuota(ctx.db, now);
  const held = heldUntil(ctx.db);
  const state = intake({ quota, freeGb, rules, now });
  if (state.code === 'X01') return { ...state, until: Math.max(held, quotaUntil(quota)), ...disk };
  return now < held ? { open: false, code: 'X01', until: held, ...disk } : state;
}

module.exports = { intakeState, blockStarts, startBlock, clearStartBlock };
