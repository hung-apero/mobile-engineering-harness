const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfluence, parseRef, serverEnv, ConfluenceError } = require('../src/specs/confluence.cjs');

const page = { metadata: { id: '123', title: 'APP1 Phase 1: demo', url: 'https://wiki.example/pages/123', version: 4, content: { format: 'markdown', value: '# demo\n\ntext' } } };
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

function fake(handlers) {
  const calls = [];
  const modes = [];
  return {
    calls, modes,
    connect: async mode => {
      modes.push(mode);
      return { callTool: async ({ name, arguments: args }) => (calls.push([name, args]), handlers[name](args)), close: async () => {} };
    },
  };
}

const tinyOf = id => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(id));
  return bytes.toString('base64').replace(/=+$/, '').replace(/A+$/, '').replace(/\//g, '-').replace(/\+/g, '_');
};

test('parseRef takes a page id, /pages/<id>/, ?pageId=, /display/<space>/<title> and /x/<tiny> links and refuses the rest', () => {
  assert.deepEqual(parseRef('332470208'), { id: '332470208' });
  assert.deepEqual(parseRef(' https://wiki.example/spaces/AB/pages/332470208/Title '), { id: '332470208' });
  assert.deepEqual(parseRef('https://wiki.example/pages/viewpage.action?pageId=77'), { id: '77' });
  assert.deepEqual(parseRef('https://wiki.example/display/AB/Title'), { space: 'AB', title: 'Title' });
  assert.deepEqual(parseRef('https://confluence.apero.vn/display/PROJ/%5BAAP864%5D+Phase+15%3A+SDK+custom+learning+path'), { space: 'PROJ', title: '[AAP864] Phase 15: SDK custom learning path' });
  for (const id of ['332470208', '2392073', '77', '4294967296']) assert.deepEqual(parseRef(`https://wiki.example/x/${tinyOf(id)}`), { id });
  for (const bad of ['', 'abc', 'https://wiki.example/', 'https://wiki.example/display/AB', 'ftp://x/pages/5/', '12345678901234567', 'https://wiki.example/x/!!', undefined]) {
    assert.throws(() => parseRef(bad), e => e instanceof ConfluenceError && e.code === 'INVALID');
  }
});

test('page reads confluence_get_page as markdown and returns the trimmed shape', async () => {
  const f = fake({ confluence_get_page: () => text(page) });
  const c = createConfluence({ configFile: '/none', connect: f.connect });
  assert.deepEqual(await c.page('https://wiki.example/pages/123/x'), { id: '123', title: 'APP1 Phase 1: demo', markdown: '# demo\n\ntext', version: 4, url: 'https://wiki.example/pages/123' });
  assert.deepEqual(f.calls, [['confluence_get_page', { page_id: '123', convert_to_markdown: true }]]);
  assert.deepEqual(f.modes, ['read']);
});

test('a /display/ link finds the page id by an exact-title CQL search, then reads by id, and a comment reuses that lookup', async () => {
  const hits = [{ id: '9', title: 'APP1 Phase 1: demo v2' }, { id: '123', title: 'APP1 Phase 1: "demo"' }];
  const f = fake({ confluence_search: () => text(hits), confluence_get_page: () => text(page), confluence_get_comments: () => text([]), confluence_add_comment: () => text({}) });
  const ref = 'https://wiki.example/display/AB/APP1+Phase+1%3A+%22demo%22';
  const c = createConfluence({ configFile: '/none', connect: f.connect, live: true });
  assert.equal((await c.page(ref)).id, '123');
  assert.deepEqual(f.calls.slice(0, 2), [
    ['confluence_search', { query: 'title = "APP1 Phase 1: \\"demo\\"" AND space = "AB"', limit: 10 }],
    ['confluence_get_page', { page_id: '123', convert_to_markdown: true }],
  ]);
  await c.commentOnce(ref, 'mk', 'xong');
  assert.deepEqual(f.calls.slice(2).map(([name, args]) => [name, args.page_id ?? args.query]), [['confluence_search', 'title = "APP1 Phase 1: \\"demo\\"" AND space = "AB"'], ['confluence_get_comments', '123'], ['confluence_add_comment', '123']]);
});

test('a /display/ title no search hit matches exactly is NOT_FOUND, not EMPTY', async () => {
  const f = fake({ confluence_search: () => text([{ id: '9', title: 'Other' }]), confluence_get_page: () => text(page) });
  const c = createConfluence({ configFile: '/none', connect: f.connect });
  await assert.rejects(c.page('https://wiki.example/display/AB/Missing'), e => e instanceof ConfluenceError && e.code === 'NOT_FOUND' && e.message.includes('Missing'));
  assert.deepEqual(f.calls.map(([name]) => name), ['confluence_search']);
});

test('an {error} answer from confluence_get_page is NOT_FOUND with its reason', async () => {
  const c = createConfluence({ configFile: '/none', connect: fake({ confluence_get_page: () => text({ error: 'Page 5 not found' }) }).connect });
  await assert.rejects(c.page('5'), e => e instanceof ConfluenceError && e.code === 'NOT_FOUND' && e.message.includes('Page 5 not found'));
});

test('an empty or malformed page is refused with a code', async () => {
  for (const body of [{ metadata: { id: '1', content: { value: '  ' } } }, 'not json', {}]) {
    const c = createConfluence({ configFile: '/none', connect: fake({ confluence_get_page: () => text(body) }).connect });
    await assert.rejects(c.page('1'), e => e instanceof ConfluenceError && e.code === 'EMPTY');
  }
});

test('serverEnv forces read-only and a single tool for reads, whatever the file says', () => {
  const server = { env: { CONFLUENCE_URL: 'u', READ_ONLY_MODE: 'false', ENABLED_TOOLS: 'confluence_delete_page,confluence_update_page' } };
  assert.deepEqual(serverEnv(server, 'read'), { CONFLUENCE_URL: 'u', READ_ONLY_MODE: 'true', ENABLED_TOOLS: 'confluence_get_page,confluence_search' });
  const write = serverEnv(server, 'write');
  assert.equal(write.READ_ONLY_MODE, undefined);
  assert.equal(write.ENABLED_TOOLS, 'confluence_get_comments,confluence_add_comment');
});

test('the config file must be 600 and not a symlink, and errors never carry the token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-conf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { confluence: { command: 'x', env: { CONFLUENCE_PERSONAL_TOKEN: 'supersecrettoken123' } } } }), { mode: 0o644 });
  await assert.rejects(createConfluence({ configFile: file }).page('1'), /quyền 600/);
  fs.chmodSync(file, 0o600);
  const link = path.join(dir, 'l.json');
  fs.symlinkSync(file, link);
  await assert.rejects(createConfluence({ configFile: link }).page('1'), /symlink/);
  const c = createConfluence({ configFile: file, connect: fake({ confluence_get_page: () => ({ isError: true, content: [{ type: 'text', text: 'denied supersecrettoken123 here' }] }) }).connect });
  await assert.rejects(c.page('1'), e => e instanceof ConfluenceError && !e.message.includes('supersecrettoken123'));
});

test('commentOnce only describes the write when not live', async () => {
  const records = [];
  const f = fake({});
  const c = createConfluence({ configFile: '/none', record: (...a) => records.push(a), connect: f.connect });
  assert.deepEqual(await c.commentOnce('55', '<!-- m1 -->', 'xem bản duyệt'), { dryRun: true });
  assert.deepEqual(records, [['would', 'confluence comment 55 <!-- m1 -->']]);
  assert.deepEqual(f.modes, []);
});

test('live commentOnce writes once and skips when the marker is already on the page', async () => {
  const comments = [];
  const f = fake({
    confluence_get_comments: () => text(comments),
    confluence_add_comment: ({ body }) => (comments.push({ body }), text({ ok: true })),
  });
  const c = createConfluence({ configFile: '/none', live: true, connect: f.connect });
  assert.deepEqual(await c.commentOnce('55', '<!-- m1 -->', 'xem bản duyệt'), { skipped: false });
  assert.deepEqual(await c.commentOnce('55', '<!-- m1 -->', 'xem bản duyệt'), { skipped: true });
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^\[Claude\] xem bản duyệt\n\n<!-- m1 -->$/);
  assert.deepEqual(f.modes, ['write']);
});

test('a dead transport during the write is confirmed by re-reading the comments', async () => {
  const comments = [];
  const f = fake({
    confluence_get_comments: () => text(comments),
    confluence_add_comment: ({ body }) => {
      comments.push({ body });
      throw new Error('EPIPE');
    },
  });
  const c = createConfluence({ configFile: '/none', live: true, connect: f.connect });
  assert.deepEqual(await c.commentOnce('55', '<!-- m2 -->', 'x'), { skipped: false });
});
