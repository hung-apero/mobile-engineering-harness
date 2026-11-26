const { inTransaction } = require('./store.cjs');
const { record } = require('../decisions.cjs');
const { redact } = require('../redact.cjs');

const ID = /^(?:dry:)?(\d+):(?:-|[A-Z][A-Z0-9]*-\d+):[A-Za-z0-9#._-]+$/;

function batchOf(id) {
  const match = ID.exec(id);
  if (!match) throw new Error(`mã tác động không hợp lệ: ${id}`);
  return Number(match[1]);
}

const effectId = (batch, key, step, live) => `${live ? '' : 'dry:'}${batch}:${key ?? '-'}:${step}`;

function getEffect(db, id) {
  const row = db.prepare('SELECT state, result, at FROM effects WHERE id = ?').get(id);
  return row ? { state: row.state, result: row.result === null ? null : JSON.parse(row.result), at: row.at } : null;
}

function save(db, id, batchId, state, result, at) {
  db.prepare(
    `INSERT INTO effects (id, batch_id, state, result, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET state = excluded.state, result = excluded.result, at = excluded.at`,
  ).run(id, batchId, state, result === undefined ? null : JSON.stringify(result), at);
}

async function once(db, id, fn, now = Date.now()) {
  const batchId = batchOf(id);
  const known = getEffect(db, id);
  if (known?.state === 'done') return known.result;
  if (!known) save(db, id, batchId, 'started', undefined, now);
  const result = await fn();
  save(db, id, batchId, 'done', result ?? null, now);
  return result ?? null;
}

function markOnce(db, id, fn, now = Date.now()) {
  const batchId = batchOf(id);
  return inTransaction(db, () => {
    const known = getEffect(db, id);
    if (known?.state === 'done') return { first: false, result: known.result };
    const result = fn() ?? null;
    save(db, id, batchId, 'done', result, now);
    return { first: true, result };
  });
}

function ruleVersionOf(ctx, key) {
  try {
    return ctx.rulesFor(key).version ?? 'không rõ';
  } catch {
    return 'không rõ';
  }
}

function recordWould(ctx, project, batch = null) {
  return (action, text) => {
    const evidence = { text: redact(text), batchId: batch?.id ?? null };
    record(ctx.db, { project: project.key, code: 'DRY', ruleVersion: ruleVersionOf(ctx, project.key), evidence, action: 'would' }, ctx.now?.() ?? Date.now());
  };
}

module.exports = { effectId, getEffect, once, markOnce, recordWould, ruleVersionOf };
