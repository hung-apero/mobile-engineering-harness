const fs = require('node:fs');
const { redactJson } = require('./redact.cjs');

const REPEAT_MS = 10 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;

function rotate(file, maxBytes) {
  try {
    if (fs.statSync(file).size >= maxBytes) fs.renameSync(file, `${file}.1`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function createServiceLog(file, { maxBytes = MAX_BYTES } = {}) {
  return (event, fields = {}) => {
    const line = redactJson({ at: new Date().toISOString(), event, ...fields });
    try {
      rotate(file, maxBytes);
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch (error) {
      process.stderr.write(`không ghi được log: ${error.code ?? 'lỗi'}\n`);
    }
  };
}

function logChanged(ctx, key, value, event) {
  const text = JSON.stringify(value);
  if (ctx.seen.get(key) === text) return;
  ctx.seen.set(key, text);
  if (value !== null) ctx.log(event, value);
}

function logRepeated(ctx, key, fields, event, now) {
  for (const [old, at] of ctx.repeats) if (Math.abs(now - at) >= REPEAT_MS) ctx.repeats.delete(old);
  if (ctx.repeats.has(key)) return;
  ctx.repeats.set(key, now);
  ctx.log(event, fields);
}

module.exports = { createServiceLog, logChanged, logRepeated };
