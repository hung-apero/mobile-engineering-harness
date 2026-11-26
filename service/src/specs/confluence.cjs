const fs = require('node:fs');
const { createClient, parse } = require('../bugs/jira-client.cjs');

const READ_TOOLS = 'confluence_get_page';
const WRITE_TOOLS = 'confluence_get_comments,confluence_add_comment';
const PAGE_ID = /^\d{1,15}$/;
const MAX_MARKDOWN = 2 * 1024 * 1024;

class ConfluenceError extends Error {
  constructor(message, { code = 'CONFLUENCE', uncertain = false } = {}) {
    super(message);
    this.name = 'ConfluenceError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

function parseRef(input) {
  const text = String(input ?? '').trim();
  if (PAGE_ID.test(text)) return { id: text };
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new ConfluenceError('Link Confluence hoặc mã trang không hợp lệ', { code: 'INVALID' });
  }
  const invalid = () => new ConfluenceError('Link Confluence không chỉ ra trang nào (cần .../pages/<số>/..., ?pageId=<số>, /display/<space>/<tiêu đề> hoặc /x/<mã>)', { code: 'INVALID' });
  if (!/^https?:$/.test(url.protocol)) throw invalid();
  const id = url.searchParams.get('pageId') ?? url.pathname.match(/\/pages\/(\d{1,15})(?:\/|$)/)?.[1] ?? tinyId(url.pathname);
  if (PAGE_ID.test(id ?? '')) return { id };
  const display = url.pathname.match(/\/display\/([^/]+)\/([^/]+)\/?$/);
  if (!display) throw invalid();
  const [space, title] = display.slice(1).map(part => decodeURIComponent(part.replace(/\+/g, ' ')).trim());
  if (!space || !title) throw invalid();
  return { space, title };
}

function tinyId(pathname) {
  const code = pathname.match(/\/x\/([A-Za-z0-9_-]{1,11})\/?$/)?.[1];
  if (!code) return null;
  const base64 = code.replace(/-/g, '/').replace(/_/g, '+').padEnd(Math.ceil(code.length / 4) * 4, 'A');
  const bytes = Buffer.from(base64, 'base64');
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value > 0n ? value.toString() : null;
}

const pageArgs = ref => (ref.id ? { page_id: ref.id } : { title: ref.title, space_key: ref.space });

function readServer(configFile) {
  const info = fs.lstatSync(configFile);
  if (info.isSymbolicLink()) throw new ConfluenceError('Cấu hình Confluence là symlink, từ chối');
  if (info.mode & 0o077) throw new ConfluenceError('Cấu hình Confluence phải có quyền 600');
  const server = JSON.parse(fs.readFileSync(configFile, 'utf8'))?.mcpServers?.confluence;
  if (!server?.command) throw new ConfluenceError('Cấu hình Confluence thiếu mcpServers.confluence');
  return server;
}

function serverEnv(server, mode) {
  const env = { ...server.env };
  if (mode === 'write') {
    delete env.READ_ONLY_MODE;
    env.ENABLED_TOOLS = WRITE_TOOLS;
  } else {
    env.READ_ONLY_MODE = 'true';
    env.ENABLED_TOOLS = READ_TOOLS;
  }
  return env;
}

function defaultConnect(configFile) {
  return async mode => {
    const server = readServer(configFile);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'dev-zone', version: '1' });
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], env: serverEnv(server, mode), stderr: 'ignore' }));
    return client;
  };
}

function secretsOf(configFile) {
  try {
    return Object.values(readServer(configFile).env ?? {}).map(String).filter(v => v.length >= 8);
  } catch {
    return [];
  }
}

function createConfluence({ configFile, live = false, record = () => {}, connect, timeoutMs }) {
  const open = connect ?? defaultConnect(configFile);
  const secrets = secretsOf(configFile);
  const readClient = createClient({ configFile, live: false, connect: () => open('read'), timeoutMs });
  const writeClient = createClient({ configFile, live: true, connect: () => open('write'), timeoutMs });

  const scrub = text => secrets.reduce((out, s) => out.split(s).join('[ẩn]'), String(text)).split('\n')[0].slice(0, 300);
  const wrap = async work => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ConfluenceError) throw error;
      throw new ConfluenceError(scrub(error?.message ?? error), { uncertain: error?.uncertain === true });
    }
  };

  const getPage = ref => wrap(async () => parse(await readClient.call('confluence_get_page', { ...pageArgs(ref), convert_to_markdown: true })));
  const idOf = async ref => ref.id ?? String((await getPage(ref))?.metadata?.id ?? '');

  async function page(input) {
    const ref = parseRef(input);
    const id = ref.id ?? ref.title;
    const meta = (await getPage(ref))?.metadata;
    const markdown = meta?.content?.value;
    if (typeof markdown !== 'string' || !markdown.trim()) throw new ConfluenceError(`Trang ${id} trống hoặc không đọc được nội dung`, { code: 'EMPTY' });
    if (markdown.length > MAX_MARKDOWN) throw new ConfluenceError(`Trang ${id} quá lớn`, { code: 'TOO_LARGE' });
    return { id: String(meta.id ?? id), title: String(meta.title ?? ''), markdown, version: Number(meta.version) || 0, url: String(meta.url ?? '') };
  }

  async function commentOnce(input, marker, text) {
    const ref = parseRef(input);
    if (!live) {
      record('would', `confluence comment ${ref.id ?? ref.title} ${marker}`);
      return { dryRun: true };
    }
    const id = await idOf(ref);
    if (!PAGE_ID.test(id)) throw new ConfluenceError(`Không tìm được mã trang của ${ref.title}`);
    const carries = () => wrap(async () => JSON.stringify(parse(await writeClient.call('confluence_get_comments', { page_id: id })) ?? '').includes(marker));
    if (await carries()) return { skipped: true };
    const body = `${text.startsWith('[Claude]') ? text : `[Claude] ${text}`}\n\n${marker}`;
    try {
      await wrap(() => writeClient.call('confluence_add_comment', { page_id: id, body }, { write: true }));
    } catch (error) {
      if (!error.uncertain || !(await carries())) throw error;
    }
    return { skipped: false };
  }

  async function close() {
    await readClient.close();
    await writeClient.close();
  }

  return { page, commentOnce, close };
}

module.exports = { createConfluence, parseRef, serverEnv, ConfluenceError, READ_TOOLS, WRITE_TOOLS };
