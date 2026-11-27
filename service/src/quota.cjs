const kv = require('./kv.cjs');
const { newestQuota } = require('./verdict.cjs');

const KEY = 'quota';
const HOLD = 'quota-hold';
const UNDATED_TTL_MS = 5 * 3600 * 1000;
const REJECTED_HOLD_MS = 5 * 60 * 1000;

function quotaUntil(quota) {
  return Number.isFinite(quota.resetsAt) ? quota.resetsAt * 1000 : quota.at + UNDATED_TTL_MS;
}

function loadQuota(db, now) {
  const quota = kv.get(db, KEY);
  if (!quota) return null;
  return Number.isFinite(quota.resetsAt) || now < quotaUntil(quota) ? quota : null;
}

function heldUntil(db) {
  return kv.get(db, HOLD) ?? 0;
}

function observeQuota(db, { quota, at }) {
  kv.transaction(db, () => {
    if (quota.status === 'rejected') kv.set(db, HOLD, Math.max(heldUntil(db), at + REJECTED_HOLD_MS), at);
    const stored = kv.get(db, KEY);
    const seen = [{ quota: { ...quota, at }, at }];
    if (stored) seen.unshift({ quota: stored, at: stored.at });
    kv.set(db, KEY, newestQuota(seen), at);
  });
}

module.exports = { loadQuota, observeQuota, quotaUntil, heldUntil };
