const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { readLines } = require('./lines.cjs');

const MAX_PATH = 103;
const MAX_CONNECTIONS = 8;
const MAX_INFLIGHT = 16;

const socketPath = dzHome => path.join(dzHome, 'desk.sock');

function probe(file) {
  return new Promise(resolve => {
    const client = net.connect(file);
    client.once('connect', () => {
      client.destroy();
      resolve(true);
    });
    client.once('error', () => resolve(false));
  });
}

async function clearStale(file) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info) return;
  if (!info.isSocket()) throw new Error('đường dẫn socket đã có file khác');
  if (await probe(file)) throw new Error('socket đang được một service khác dùng');
  fs.unlinkSync(file);
}

function checkHome(dzHome, file) {
  if (Buffer.byteLength(file) > MAX_PATH) throw new Error('đường dẫn DZ_HOME quá dài cho unix socket');
  if (fs.statSync(dzHome).mode & 0o077) throw new Error('thư mục DZ_HOME phải có quyền 700');
}

function listen(server, file) {
  return new Promise((resolve, reject) => {
    const old = process.umask(0o177);
    try {
      server.once('error', reject);
      server.listen(file, () => {
        server.off('error', reject);
        resolve();
      });
    } finally {
      process.umask(old);
    }
  });
}

function parse(line) {
  try {
    const value = JSON.parse(line);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function createDeskSocket({ dzHome, desk, log = () => {} }) {
  const file = socketPath(dzHome);
  const clients = new Set();
  let server = null;

  function serve(socket) {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => socket.destroy());
    let inflight = 0;
    const answer = async line => {
      const request = parse(line);
      const id = Number.isInteger(request?.id) ? request.id : null;
      if (!request || id === null || inflight >= MAX_INFLIGHT) return socket.destroy();
      inflight += 1;
      const result = await desk.call(request.tool, request.args);
      inflight -= 1;
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...result })}\n`);
    };
    readLines(socket, line => answer(line).catch(() => socket.destroy()), () => socket.destroy());
  }

  async function start() {
    checkHome(dzHome, file);
    await clearStale(file);
    server = net.createServer(serve);
    server.maxConnections = MAX_CONNECTIONS;
    await listen(server, file);
    fs.chmodSync(file, 0o600);
    server.on('error', error => log('desk-socket-error', { code: error.code ?? 'lỗi' }));
    return { file };
  }

  async function stop() {
    if (!server) return;
    const closing = new Promise(resolve => server.close(resolve));
    for (const socket of clients) socket.destroy();
    await closing;
    server = null;
  }

  return { start, stop };
}

module.exports = { createDeskSocket, socketPath };
