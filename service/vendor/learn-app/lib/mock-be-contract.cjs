const fs = require('fs');
const path = require('path');
const { validate } = require('./json-schema-lite.cjs');
const { compilePath, matchRoute, fillParams, missingHeaders, scenarios } =require('../templates/mock-be/server.cjs');

const ROUTE = {
  type: 'object',
  required: ['method', 'path'],
  properties: {
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    path: { type: 'string' },
    file: { type: 'string' },
    status: { type: 'integer' },
    requireHeaders: { type: 'array', items: { type: 'string' } },
  },
};
const SCHEMA = { type: 'object', required: ['routes'], properties: { basePaths: { type: 'object' }, routes: { type: 'array', items: ROUTE } } };
const NOT_DATA = new Set(['contract.json', 'server.cjs', 'README.md']);

function contractProblems(contract) {
  const errors = validate(SCHEMA, contract);
  if (errors.length) return errors;
  const bases = Object.values(contract.basePaths || {});
  const seen = new Set();
  contract.routes.forEach((route, index) => {
    const at = `routes[${index}] ${route.method} ${route.path}`;
    if (!route.path.startsWith('/')) errors.push(`${at}: path phải bắt đầu bằng /`);
    if (bases.length && !bases.some(base => route.path.startsWith(`${base.replace(/\/$/, '')}/`))) errors.push(`${at}: path không nằm dưới basePaths ${bases.join(', ')}`);
    if (!route.file && route.status === undefined) errors.push(`${at}: cần file hoặc status`);
    if (route.status !== undefined && (route.status < 200 || route.status > 599)) errors.push(`${at}: status phải trong 200-599`);
    if (route.file && (path.isAbsolute(route.file) || route.file.split('/').includes('..'))) errors.push(`${at}: file phải là đường dẫn tương đối trong mock-be/`);
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) errors.push(`${at}: trùng route`);
    seen.add(key);
  });
  return errors;
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.')).flatMap(entry => {
    const abs = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(abs, base) : [path.relative(base, abs).split(path.sep).join('/')];
  });
}

function parseError(file) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return null;
  } catch (error) {
    return error.message;
  }
}

function checkMockDir(dir) {
  const missing = [];
  const errors = [];
  if (!fs.existsSync(path.join(dir, 'server.cjs'))) missing.push('server.cjs');
  if (!fs.existsSync(path.join(dir, 'contract.json'))) return { ok: false, missing: [...missing, 'contract.json'], errors };
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(path.join(dir, 'contract.json'), 'utf8'));
  } catch (error) {
    return { ok: false, missing, errors: [`contract.json: ${error.message}`] };
  }
  errors.push(...contractProblems(contract));
  if (errors.length) return { ok: false, missing, errors };
  const dataFiles = walk(dir).filter(file => !file.startsWith('scenarios/') && !NOT_DATA.has(file));
  const patterns = contract.routes.filter(route => route.file).map(route => ({ file: route.file, regex: compilePath(route.file).regex }));
  for (const { file, regex } of patterns) {
    const hits = dataFiles.filter(candidate => regex.test(candidate));
    if (!hits.length) missing.push(file);
    for (const hit of hits) {
      const problem = parseError(path.join(dir, hit));
      if (problem) errors.push(`${hit}: JSON hỏng — ${problem}`);
    }
  }
  for (const name of scenarios(dir)) {
    for (const file of walk(path.join(dir, 'scenarios', name))) {
      if (!patterns.some(p => p.regex.test(file))) errors.push(`scenarios/${name}/${file}: contract.json không có route nào trả file này`);
      const problem = parseError(path.join(dir, 'scenarios', name, file));
      if (problem) errors.push(`scenarios/${name}/${file}: JSON hỏng — ${problem}`);
    }
  }
  return { ok: !missing.length && !errors.length, missing, errors };
}

module.exports = { SCHEMA, contractProblems, checkMockDir, compilePath, matchRoute, fillParams, missingHeaders, scenarios };
