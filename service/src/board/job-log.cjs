const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('../redact.cjs');

const LIVE = ['queued', 'starting', 'running'];
const MAX_TEXT = 500;
const MAX_TOOL = 200;

const ASSIGNED_SECRET = /((?:password|passwd|secret|token|api[_-]?key|auth)\w*\s*[=:]\s*)[^\s"'&;|]+/gi;

const clip = (text, max) => {
  const flat = redact(String(text ?? '')).replace(ASSIGNED_SECRET, '$1[ẩn]').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function toolText(name, input = {}) {
  const main = input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.description ?? input.url ?? JSON.stringify(input);
  return clip(`${name}: ${main}`, MAX_TOOL);
}

const resultText = content => (typeof content === 'string' ? content : (Array.isArray(content) ? content : []).map(part => part?.text ?? '').join(' '));

function rowsOf(event) {
  const at = Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : null;
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  if (event.type === 'assistant') {
    return content.flatMap(part => {
      if (part?.type === 'text' && part.text?.trim()) return [{ at, kind: 'say', text: clip(part.text, MAX_TEXT) }];
      if (part?.type === 'tool_use') return [{ at, kind: 'tool', text: toolText(part.name, part.input) }];
      return [];
    });
  }
  if (event.type === 'user') {
    return content.filter(part => part?.type === 'tool_result' && part.is_error).map(part => ({ at, kind: 'error', text: clip(resultText(part.content), MAX_TOOL) }));
  }
  if (event.type === 'system' && event.subtype === 'permission_denied') return [{ at, kind: 'error', text: clip(`Bị chặn: ${event.tool_name}`, MAX_TOOL) }];
  if (event.type === 'result') {
    const cost = Number.isFinite(event.total_cost_usd) ? ` · ${Math.round(event.total_cost_usd * 100) / 100} USD` : '';
    const turns = Number.isFinite(event.num_turns) ? ` · ${event.num_turns} lượt` : '';
    return [{ at, kind: event.is_error ? 'error' : 'result', text: `${event.is_error ? 'Lỗi' : 'Xong'}${cost}${turns}` }];
  }
  return [];
}

function parseLine(line) {
  try {
    return rowsOf(JSON.parse(line));
  } catch {
    return [];
  }
}

function insideLogs(ctx, file) {
  if (typeof file !== 'string' || !file) return false;
  const root = path.resolve(ctx.dzHome, 'logs');
  return path.resolve(file).startsWith(`${root}${path.sep}`);
}

function readChunk(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function readJobLog(ctx, job, offset, { maxBytes = 65536, maxLines = 200 } = {}) {
  const done = !LIVE.includes(job.state);
  const empty = { lines: [], offset: 0, done };
  if (!insideLogs(ctx, job.logFile)) return empty;
  let size;
  try {
    size = fs.statSync(job.logFile).size;
  } catch {
    return empty;
  }
  const tail = offset === null || offset === undefined;
  let start = tail ? Math.max(0, size - maxBytes) : Number(offset);
  if (!Number.isInteger(start) || start < 0 || start > size) start = 0;
  let chunk = readChunk(job.logFile, start, Math.min(maxBytes, size - start));
  if (tail && start > 0) {
    const first = chunk.indexOf(0x0a);
    start += first + 1;
    chunk = chunk.subarray(first + 1);
  }
  const last = chunk.lastIndexOf(0x0a);
  if (last < 0) return { lines: [], offset: chunk.length >= maxBytes ? start + chunk.length : start, done };
  const lines = chunk.subarray(0, last).toString('utf8').split('\n').flatMap(parseLine);
  return { lines: lines.slice(-maxLines), offset: start + last + 1, done };
}

module.exports = { readJobLog };
