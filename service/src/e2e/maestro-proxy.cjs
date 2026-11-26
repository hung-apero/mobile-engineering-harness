const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { judgeMaestro } = require('./maestro-rules.cjs');

function refusal(id, reason) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Service từ chối: ${reason}` }], isError: true } };
}

function verdict(message, config) {
  if (message?.method !== 'tools/call') return null;
  try {
    return judgeMaestro(message.params?.name, message.params?.arguments, config);
  } catch {
    return 'không kiểm được lệnh';
  }
}

function lines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) onLine(line);
    }
  });
}

function startProxy(config, { input = process.stdin, output = process.stdout, launch = spawn } = {}) {
  const hello = [];
  const open = new Map();
  let child = null;
  const reply = message => output.write(`${JSON.stringify(message)}\n`);

  function connect() {
    const own = launch(config.maestro, ['mcp'], { stdio: ['pipe', 'pipe', 'inherit'], env: config.env ? { ...process.env, ...config.env } : process.env });
    child = own;
    let muted = hello.length > 0 ? JSON.parse(hello[0]).id : undefined;
    lines(own.stdout, line => {
      let id;
      try {
        id = JSON.parse(line).id;
      } catch {
        return;
      }
      if (muted !== undefined && id === muted) {
        muted = undefined;
        return;
      }
      open.delete(id);
      output.write(`${line}\n`);
    });
    own.stdin.on('error', () => {});
    const gone = () => {
      if (child !== own) return;
      child = null;
      for (const id of open.keys()) reply(refusal(id, 'Maestro đã dừng, hãy gọi lại'));
      open.clear();
    };
    own.on('error', gone);
    own.on('exit', gone);
    for (const line of hello) own.stdin.write(`${line}\n`);
  }

  lines(input, line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return;
    const reason = verdict(message, config);
    if (reason !== null) {
      if (message.id !== undefined) reply(refusal(message.id, reason));
      return;
    }
    if (!child) connect();
    const clean = JSON.stringify(message);
    if (['initialize', 'notifications/initialized'].includes(message.method)) hello.push(clean);
    if (message.id !== undefined && message.method) open.set(message.id, true);
    child.stdin.write(`${clean}\n`);
  });
  input.on('end', () => child?.kill());
}

if (require.main === module) startProxy(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));

module.exports = { startProxy };
