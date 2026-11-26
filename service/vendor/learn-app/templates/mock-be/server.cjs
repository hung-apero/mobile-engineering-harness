// learn-app mock-be server __VERSION__
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 8787;
const BUILT_IN = ['full', 'error'];

function compilePath(pattern) {
  const names = [];
  const source = pattern.split(/(:[A-Za-z_]\w*)/).map(part => {
    if (/^:[A-Za-z_]\w*$/.test(part)) {
      names.push(part.slice(1));
      return '([^/]+?)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return { regex: new RegExp(`^${source}/?$`), names };
}

function matchRoute(routes, method, urlPath) {
  for (const route of routes) {
    if (String(route.method).toUpperCase() !== method.toUpperCase()) continue;
    const { regex, names } = compilePath(route.path);
    const found = regex.exec(urlPath);
    if (found) return { route, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1])])) };
  }
  return null;
}

function fillParams(file, params) {
  return file.replace(/:([A-Za-z_]\w*)/g, (token, name) => (name in params ? params[name] : token));
}

function missingHeaders(route, headers) {
  return (route.requireHeaders || []).filter(name => !headers[name.toLowerCase()]);
}

function scenarios(dir) {
  const root = path.join(dir, 'scenarios');
  const found = fs.existsSync(root) ? fs.readdirSync(root).filter(name => fs.statSync(path.join(root, name)).isDirectory()) : [];
  return [...new Set([...BUILT_IN, ...found])];
}

function resolveFile(dir, scenario, file) {
  const override = path.join(dir, 'scenarios', scenario, file);
  return fs.existsSync(override) ? override : path.join(dir, file);
}

function inside(dir, file) {
  const relative = path.relative(dir, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readContract(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'contract.json'), 'utf8'));
}

function respond(dir, state, req) {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const contract = readContract(dir);
  if (urlPath === '/__routes') return { status: 200, body: contract.routes };
  if (urlPath === '/__scenario') {
    const available = scenarios(dir);
    if (req.method !== 'POST') return { status: 200, body: { name: state.scenario, available } };
    let name;
    try {
      name = JSON.parse(req.body || '{}').name;
    } catch {
      return { status: 400, body: { error: 'mock-be: body phải là JSON {"name": "<scenario>"}' } };
    }
    if (!available.includes(name)) return { status: 400, body: { error: `mock-be: không có scenario ${name}`, available } };
    state.scenario = name;
    return { status: 200, body: { name } };
  }
  const hit = matchRoute(contract.routes || [], req.method, urlPath);
  if (!hit) return { status: 404, body: { error: `mock-be: contract.json không có route ${req.method} ${urlPath}` } };
  const missing = missingHeaders(hit.route, req.headers);
  if (missing.length) return { status: 400, body: { error: `mock-be: thiếu header ${missing.join(', ')}` } };
  if (state.scenario === 'error') return { status: 500, body: { error: 'mock-be: scenario error' } };
  if (!hit.route.file) return { status: hit.route.status || 204, body: {} };
  const relative = fillParams(hit.route.file, hit.params);
  const file = resolveFile(dir, state.scenario, relative);
  if (!inside(dir, file)) return { status: 400, body: { error: 'mock-be: tham số đường dẫn không hợp lệ' } };
  if (!fs.existsSync(file)) return { status: 404, body: { error: `mock-be: thiếu file ${relative}` }, file: relative };
  return { status: hit.route.status || 200, raw: fs.readFileSync(file, 'utf8'), file: path.relative(dir, file) };
}

function createServer(dir, state = { scenario: 'full' }) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let result;
      try {
        result = respond(dir, state, { method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
      } catch (error) {
        result = { status: 500, body: { error: `mock-be: ${error.message}` } };
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(result.raw !== undefined ? result.raw : JSON.stringify(result.body));
      console.log(`${req.method} ${req.url} [${state.scenario}] ${result.status} ${result.file || '-'}`);
    });
  });
}

function portArg(argv) {
  const index = argv.indexOf('--port');
  const port = index > 0 ? Number(argv[index + 1]) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`mock-be: --port phải là số 1-65535, gặp ${argv[index + 1]}`);
  return port;
}

if (require.main === module) {
  const port = portArg(process.argv);
  createServer(__dirname).listen(port, '127.0.0.1', () => console.log(`mock-be: http://localhost:${port} (scenario full) — ${path.join(__dirname, 'contract.json')}`));
}

module.exports = { DEFAULT_PORT, BUILT_IN, compilePath, matchRoute, fillParams, missingHeaders, scenarios, resolveFile, respond, createServer };
