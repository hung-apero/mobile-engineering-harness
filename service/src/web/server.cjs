const http = require('node:http');
const path = require('node:path');
const { firstLine } = require('../redact.cjs');
const { HEADERS, checkHost, checkOrigin, publicHost } = require('./guard.cjs');
const { readJson } = require('./body.cjs');
const { createTokenGuard } = require('./token-guard.cjs');
const { createOperator } = require('./operator.cjs');
const { loadStatic } = require('./static-files.cjs');
const { findRoute } = require('./routes.cjs');
const { messagePage } = require('./html.cjs');
const { WebError, toWebError } = require('./web-error.cjs');
const { resolveViewer } = require('../board/tokens.cjs');

const DEFAULT_PORT = 8787;

function readPort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('DZ_WEB_PORT phải là số từ 0 tới 65535');
  return port;
}

function defaultResolve(db, token, purpose, now) {
  return require('../specs/store.cjs').resolveToken(db, token, purpose, now);
}

function createWeb(ctx, { facade, host, port, now = Date.now, resolveToken = defaultResolve }) {
  const bindHost = (host ?? ctx.env?.DZ_WEB_HOST) || '127.0.0.1';
  const wantedPort = readPort(port ?? ctx.env?.DZ_WEB_PORT);
  const files = loadStatic();
  const tokens = createTokenGuard(now);
  const operator = createOperator(ctx.secretsDir ?? path.join(ctx.dzHome, 'secrets'), now);
  let server = null;

  function reply(res, status, type, body) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  }

  const html = (res, status, body) => reply(res, status, 'text/html; charset=utf-8', body);
  const json = (res, status, body) => reply(res, status, 'application/json; charset=utf-8', JSON.stringify(body));

  function authorize(req, res, route, token, query) {
    const address = req.socket.remoteAddress ?? '';
    if (route.auth === 'viewer') {
      const viewer = tokens.check(address, token, value => resolveViewer(ctx.db, value, now()));
      if (viewer === null) throw new WebError(404, 'NOT_FOUND');
      const session = operator.cookieOf(req);
      return { viewer, operator: Boolean(session && operator.isSession(session)) };
    }
    if (route.auth !== 'operator') {
      const specId = tokens.check(address, token, value => resolveToken(ctx.db, value, route.auth, now()));
      if (specId === null) throw new WebError(404, 'NOT_FOUND');
      return { specId };
    }
    const key = route.login ? query.get('k') : null;
    if (key && tokens.check(address, key, operator.isToken)) {
      res.setHeader('set-cookie', operator.open());
      return { login: true };
    }
    const session = key ? null : operator.cookieOf(req);
    if (!session || !tokens.check(address, session, operator.isSession)) throw new WebError(403, 'OPERATOR');
    return {};
  }

  async function serve(req, res, found) {
    const { route, token, query, params } = found;
    if (!route.methods.includes(req.method)) {
      res.setHeader('allow', route.methods.join(', '));
      throw new WebError(405, 'METHOD');
    }
    if (req.method === 'POST') checkOrigin(req);
    const auth = authorize(req, res, route, token, query);
    if (auth.login) return html(res, 200, messagePage('Đã mở khoá', 'Đang vào trang trạng thái…', { refresh: '/' }));
    const body = req.method === 'POST' ? await readJson(req, res) : null;
    const result = await route.run({ ctx, facade, specId: auth.specId, viewer: auth.viewer, operator: auth.operator === true, body, token, params, query, now: now() });
    return route.api ? json(res, 200, { ok: true, ...result }) : html(res, 200, result);
  }

  function failed(req, res, found, error) {
    const known = toWebError(error);
    if (known.status === 500) ctx.log?.('web-error', { route: found?.route.name ?? 'khác', error: firstLine(error) });
    if (known.extra.retryAfter) res.setHeader('retry-after', String(known.extra.retryAfter));
    if (found?.route.api) return json(res, known.status, { ok: false, code: known.code, error: known.message, ...known.extra });
    return html(res, known.status, messagePage('Không mở được', known.message));
  }

  async function handle(req, res) {
    for (const [name, value] of Object.entries(HEADERS)) res.setHeader(name, value);
    let found = null;
    try {
      const [pathname, search = ''] = String(req.url).split('?', 2);
      found = findRoute(pathname, search);
      checkHost(req, bindHost, server.address().port);
      const file = files.get(pathname);
      if (file && ['GET', 'HEAD'].includes(req.method)) return reply(res, 200, file.type, file.body);
      if (!found) throw new WebError(404, 'MISSING_PAGE');
      await serve(req, res, found);
    } catch (error) {
      failed(req, res, found, error);
    }
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer({ requestTimeout: 30000 }, handle);
      server.once('error', reject);
      server.listen(wantedPort, bindHost, () => {
        server.off('error', reject);
        server.on('error', error => ctx.log?.('web-error', { route: 'server', error: firstLine(error) }));
        try {
          operator.issue();
          resolve({ url: `http://${publicHost(bindHost)}:${server.address().port}` });
        } catch (error) {
          stop().then(() => reject(error));
        }
      });
    });
  }

  function stop() {
    return new Promise(resolve => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { start, stop };
}

module.exports = { createWeb };
