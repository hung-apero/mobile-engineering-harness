const fs = require('node:fs');

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const MISSING_SESSION = 'No conversation found with session ID';

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

function findNewlineFrom(fd, position, size, chunk) {
  for (let at = position; at < size; at += chunk) {
    const buffer = readAt(fd, at, Math.min(chunk, size - at));
    const index = buffer.indexOf(NEWLINE);
    if (index !== -1) return at + index + 1;
  }
  return -1;
}

function parseLines(buffer) {
  const events = [];
  let bad = 0;
  let missing = false;
  for (const raw of buffer.toString('utf8').split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value);
      else bad += 1;
    } catch {
      bad += 1;
      if (text.includes(MISSING_SESSION)) missing = true;
    }
  }
  return { events, bad, ...(missing && { missingSession: true }) };
}

function readEvents(file, offset, chunk = DEFAULT_CHUNK) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return { events: [], offset: 0, bad: 0 };
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (offset > size) return { ...readEventsFrom(fd, 0, size, chunk), truncated: true };
    return readEventsFrom(fd, offset, size, chunk);
  } finally {
    fs.closeSync(fd);
  }
}

function readEventsFrom(fd, offset, size, chunk) {
  if (offset >= size) return { events: [], offset, bad: 0 };
  const buffer = readAt(fd, offset, Math.min(chunk, size - offset));
  const last = buffer.lastIndexOf(NEWLINE);
  if (last !== -1) {
    return { ...parseLines(buffer.subarray(0, last + 1)), offset: offset + last + 1 };
  }
  if (buffer.length < chunk) return { events: [], offset, bad: 0 };
  const end = findNewlineFrom(fd, offset + buffer.length, size, chunk);
  if (end === -1) return { events: [], offset, bad: 0 };
  return { events: [], offset: end, bad: 1 };
}

function quotaOf(info) {
  const windows = Object.values(info.unifiedWindows || {}).filter(w => w && typeof w.utilization === 'number');
  const top = windows.sort((a, b) => b.utilization - a.utilization)[0];
  if (top) return { utilization: top.utilization, resetsAt: top.resetsAt ?? info.resetsAt ?? null, status: info.status ?? top.status ?? null };
  return { utilization: null, resetsAt: info.resetsAt ?? null, status: info.status ?? null };
}

function saysMissingSession(result) {
  const texts = [result.result, ...(Array.isArray(result.errors) ? result.errors : [])];
  return result.is_error === true && texts.some(t => String(t).includes(MISSING_SESSION));
}

const startsTurn = e => (e.type === 'assistant' && !e.parent_tool_use_id) || (e.type === 'system' && e.subtype === 'init');

function summarize(events) {
  const results = events.filter(e => e.type === 'result');
  const limits = events.filter(e => e.type === 'rate_limit_event' && e.rate_limit_info);
  const changes = events.filter(e => e.type === 'system' && e.subtype === 'background_tasks_changed' && Array.isArray(e.tasks));
  const lastResult = events.findLastIndex(e => e.type === 'result');
  const lastLimit = limits[limits.length - 1];
  return {
    result: lastResult === -1 ? null : events[lastResult],
    results: results.length,
    quota: lastLimit ? quotaOf(lastLimit.rate_limit_info) : null,
    denials: results.flatMap(r => (Array.isArray(r.permission_denials) ? r.permission_denials : [])),
    tasks: changes.length ? changes[changes.length - 1].tasks : null,
    answered: events.some(e => e.type === 'assistant'),
    turnOpen: events.slice(lastResult + 1).some(startsTurn),
    missingSession: results.some(saysMissingSession),
  };
}

module.exports = { readEvents, summarize };
