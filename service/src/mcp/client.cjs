const net = require('node:net');
const { readLines } = require('./lines.cjs');

const TIMEOUT_MS = 90000;
const MAX_REPLY = 1024 * 1024;
const OFFLINE = { ok: false, error: { code: 'OFFLINE', message: 'Service chưa chạy hoặc mất kết nối. Tin chưa ack vẫn còn trong pending.' } };

function callService(file, tool, args, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(file);
    const finish = value => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(OFFLINE), timeoutMs);
    socket.on('error', () => finish(OFFLINE));
    socket.on('close', () => finish(OFFLINE));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, tool, args })}\n`));
    readLines(socket, line => {
      try {
        const { ok, result, error } = JSON.parse(line);
        finish(ok === true ? { ok, result } : { ok: false, error });
      } catch {
        finish(OFFLINE);
      }
    }, () => finish(OFFLINE), MAX_REPLY);
  });
}

module.exports = { callService };
