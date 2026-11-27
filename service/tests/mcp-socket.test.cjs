const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createDeskSocket, socketPath } = require('../src/mcp/socket.cjs');
const { callService } = require('../src/mcp/client.cjs');
const { createDzServer } = require('../src/mcp/server.cjs');
const { TOOLS } = require('../src/mcp/tools.cjs');
const { CHANNEL, idAt, NOW, TOKEN, tempHome, review, setup } = require('./mcp-fixtures.cjs');
const { say } = require('./mcp-approve-fixtures.cjs');

async function startSocket(t, desk, dzHome = tempHome()) {
  const socket = createDeskSocket({ dzHome, desk });
  await socket.start();
  t.after(async () => {
    await socket.stop();
    fs.rmSync(dzHome, { recursive: true, force: true });
  });
  return { socket, dzHome, file: socketPath(dzHome) };
}

const echo = { call: async (tool, args) => ({ ok: true, result: { tool, args } }) };

function raw(file, text) {
  return new Promise(resolve => {
    const client = net.connect(file, () => client.write(text));
    let out = '';
    client.on('data', chunk => {
      out += chunk;
    });
    client.on('error', () => {});
    client.on('close', () => resolve(out));
  });
}

test('the socket is mode 600 and is removed on stop', async t => {
  const { socket, file } = await startSocket(t, echo);
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
  await socket.stop();
  assert.equal(fs.existsSync(file), false);
});

test('a home that others can enter is refused', async t => {
  const dzHome = tempHome();
  t.after(() => fs.rmSync(dzHome, { recursive: true, force: true }));
  fs.chmodSync(dzHome, 0o755);
  await assert.rejects(createDeskSocket({ dzHome, desk: echo }).start(), /700/);
});

test('a stale socket is replaced, a live one or another file is not', async t => {
  const { socket, dzHome, file } = await startSocket(t, echo);
  await assert.rejects(createDeskSocket({ dzHome, desk: echo }).start(), /đang được/);
  assert.equal((await callService(file, 'pending', {})).ok, true);
  await socket.stop();
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(file)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  assert.equal(child.signal, 'SIGKILL');
  assert.ok(fs.lstatSync(file).isSocket());
  await socket.start();
  assert.equal((await callService(file, 'pending', {})).ok, true);
  await socket.stop();
  fs.writeFileSync(file, 'x');
  await assert.rejects(socket.start(), /file khác/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  fs.unlinkSync(file);
});

test('garbage, oversized lines and missing ids close the connection without calling the desk', async t => {
  const calls = [];
  const { file } = await startSocket(t, { call: async (...args) => calls.push(args) });
  for (const text of ['xin chào\n', '[]\n', '{"tool":"ack"}\n', `${'a'.repeat(70000)}`, `{"id":1,"x":"${'a'.repeat(70000)}"}\n`]) assert.equal(await raw(file, text), '');
  assert.deepEqual(calls, []);
});

test('a service that is down gives a clear error instead of hanging', async () => {
  const result = await callService('/private/tmp/dz-khong-co.sock', 'pending', {});
  assert.equal(result.error.code, 'OFFLINE');
  assert.match(result.error.message, /pending/);
});

test('a hung service times out', async t => {
  const { file } = await startSocket(t, { call: () => new Promise(() => {}) });
  assert.equal((await callService(file, 'pending', {}, { timeoutMs: 50 })).error.code, 'OFFLINE');
});

test('a full pending list passes through the socket', async t => {
  const messages = Array.from({ length: 50 }, () => 'đ'.repeat(2000));
  const { file } = await startSocket(t, { call: async () => ({ ok: true, result: { messages } }) });
  assert.equal((await callService(file, 'pending', {})).result.messages.length, 50);
});

async function connect(server) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test('dz offers exactly seven tools that take ids only', async t => {
  const client = await connect(createDzServer({ call: echo.call }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['submit', 'answer', 'approve', 'ask', 'status', 'pending', 'ack']);
  for (const { inputSchema } of tools) {
    assert.equal(inputSchema.additionalProperties, false);
    assert.ok(Object.keys(inputSchema.properties).every(name => ['message_id', 'channel_id'].includes(name)));
    assert.ok(Object.values(inputSchema.properties).every(value => value.pattern === '^[0-9]{17,20}$'));
  }
  assert.equal(TOOLS.length, 7);
});

test('dz rejects claims before they reach the service', async t => {
  const calls = [];
  const client = await connect(createDzServer({ call: async (...args) => calls.push(args) }));
  t.after(() => client.close());
  const args = { message_id: idAt(NOW), channel_id: CHANNEL };
  for (const [name, extra] of [['approve', { author: 'po' }], ['answer', { text: 'Q1: A' }], ['submit', { role: 'po' }], ['bash', {}]]) {
    const result = await client.callTool({ name, arguments: { ...args, ...extra } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).code, 'INVALID');
  }
  assert.deepEqual(calls, []);
});

test('the real stdio server reaches the service over the socket and carries no token', async t => {
  const s = setup(t, { specs: [review(1)] });
  const { file, dzHome } = await startSocket(t, s.desk);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'src', 'mcp', 'server.cjs')], env: { DZ_HOME: dzHome, PATH: process.env.PATH } }));
  t.after(() => client.close());
  assert.equal(fs.existsSync(file), true);
  const result = await client.callTool({ name: 'approve', arguments: { message_id: say(s, 'duyệt'), channel_id: CHANNEL } });
  assert.equal(JSON.parse(result.content[0].text).decision, 'approved');
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});
