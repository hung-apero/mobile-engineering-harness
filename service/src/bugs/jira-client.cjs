const fs = require('node:fs');
const { redact } = require('../redact.cjs');

const ALLOWED_TOOLS = 'jira_get_issue,jira_search,jira_get_transitions,jira_transition_issue,jira_add_comment,jira_update_issue,jira_download_attachments';

class JiraError extends Error {
  constructor(message, { uncertain = false } = {}) {
    super(message);
    this.name = 'JiraError';
    this.uncertain = uncertain;
  }
}

function readConfig(configFile) {
  const info = fs.lstatSync(configFile);
  if (info.isSymbolicLink()) throw new JiraError('Cấu hình Jira là symlink, từ chối');
  if (info.mode & 0o077) throw new JiraError('Cấu hình Jira phải có quyền 600');
  const server = JSON.parse(fs.readFileSync(configFile, 'utf8'))?.mcpServers?.jira;
  if (!server?.command) throw new JiraError('Cấu hình Jira thiếu mcpServers.jira');
  return server;
}

function defaultConnect(configFile, live, tools) {
  return async () => {
    const server = readConfig(configFile);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const env = { ...server.env, ENABLED_TOOLS: tools };
    if (!live) env.READ_ONLY_MODE = 'true';
    const client = new Client({ name: 'dev-zone', version: '1' });
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], env, stderr: 'ignore' }));
    return client;
  };
}

function secretsOf(configFile) {
  try {
    return Object.values(readConfig(configFile).env ?? {}).map(String).filter(v => v.length >= 8);
  } catch {
    return [];
  }
}

const isDead = e => /closed|not connected|EPIPE|ECONNRESET|spawn/i.test(String(e?.message)) || e?.code === -32000;

function createClient({ configFile, live, connect, timeoutMs = 60000, tools = ALLOWED_TOOLS }) {
  const open = connect ?? defaultConnect(configFile, live, tools);
  const secrets = secretsOf(configFile);
  let current = null;

  const clean = text => secrets.reduce((out, s) => out.split(s).join('[ẩn]'), redact(text)).split('\n')[0].slice(0, 300);
  const fail = (text, opts) => new JiraError(clean(text), opts);

  async function drop() {
    const c = current;
    current = null;
    try {
      await c?.close();
    } catch {}
  }

  function withTimeout(promise) {
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('hết thời gian chờ Jira'), { timeout: true })), timeoutMs);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  }

  async function call(name, args, { write = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result;
      try {
        current ??= await withTimeout(open());
        result = await withTimeout(current.callTool({ name, arguments: args }));
      } catch (error) {
        const transport = error?.timeout || isDead(error);
        await drop();
        if (!transport) throw fail(error?.message ?? error);
        if (write) throw fail(`${name}: không rõ kết quả (${error.message})`, { uncertain: true });
        if (attempt === 1) throw fail(`${name}: mất kết nối Jira (${error.message})`);
        continue;
      }
      if (result?.isError) throw fail(`${name}: ${result.content?.find(c => c.type === 'text')?.text ?? 'lỗi'}`);
      return result;
    }
    throw fail(`${name}: mất kết nối Jira`);
  }

  return { call, close: drop, fail, clean };
}

function parse(result) {
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (text === undefined) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (value && typeof value.result === 'string' && Object.keys(value).length === 1) {
    try {
      return JSON.parse(value.result);
    } catch {
      return value.result;
    }
  }
  return value;
}

module.exports = { createClient, parse, JiraError, ALLOWED_TOOLS };
