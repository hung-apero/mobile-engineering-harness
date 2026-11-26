const fs = require('node:fs');

const MAX_BYTES = 64 * 1024 * 1024;
const NEWLINE = 0x0a;

function openRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (fs.fstatSync(fd).isFile()) return fd;
  fs.closeSync(fd);
  throw new Error(`${file} không phải file thường`);
}

function readTail(file, maxBytes = MAX_BYTES) {
  const fd = openRegular(file);
  if (fd === null) return null;
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - maxBytes);
    const from = Math.max(0, start - 1);
    const buffer = Buffer.alloc(size - from);
    let read = 0;
    while (read < buffer.length) {
      const got = fs.readSync(fd, buffer, read, buffer.length - read, from + read);
      if (got === 0) break;
      read += got;
    }
    const data = buffer.subarray(0, read);
    if (start === 0) return { data, cut: false };
    const first = data.indexOf(NEWLINE);
    return { data: first === -1 ? data.subarray(0, 0) : data.subarray(first + 1), cut: true };
  } finally {
    fs.closeSync(fd);
  }
}

function resultIn(line) {
  if (!line.startsWith('{') || !line.includes('"result"')) return null;
  try {
    const event = JSON.parse(line);
    return event.type === 'result' ? event : null;
  } catch {
    return null;
  }
}

function describe(event) {
  let text = '';
  if (typeof event.result === 'string') text = event.result;
  else if (Array.isArray(event.errors)) text = event.errors.map(String).join('\n');
  const subtype = typeof event.subtype === 'string' ? event.subtype : null;
  return { text, structuredOutput: event.structured_output ?? null, isError: event.is_error !== false || subtype !== 'success', subtype };
}

function lastResultText(file, { maxBytes } = {}) {
  const tail = readTail(file, maxBytes);
  if (!tail) return null;
  let end = tail.data.length;
  while (end > 0) {
    const start = tail.data.lastIndexOf(NEWLINE, end - 1) + 1;
    const event = resultIn(tail.data.toString('utf8', start, end).trim());
    if (event) return describe(event);
    end = start - 1;
  }
  return null;
}

module.exports = { lastResultText, readTail };
