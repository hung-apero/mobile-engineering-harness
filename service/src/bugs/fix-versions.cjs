const kv = require('../kv.cjs');
const store = require('./store.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;
const MISSING_MS = 10 * 60 * 1000;
const MAX_EXTRA = 10;
const NOT_FOUND = /\bvalue\b.* does not exist for the field '?fixVersion\b/i;
const namesKey = (project, version) => `bug-fixver:${project}:${version}`;
const cacheKey = (project, name) => `bug-fixver-exists:${project}:${name}`;

function parseList(text) {
  const names = text.split(',');
  if (names.length > MAX_EXTRA || new Set(names).size !== names.length || !names.every(name => store.VERSION_RE.test(name))) return null;
  return names;
}

async function exists(ctx, project, jira, name, now) {
  const cached = kv.get(ctx.db, cacheKey(project.key, name));
  if (cached && now - cached.at < (cached.exists ? DAY_MS : MISSING_MS)) return cached.exists;
  let found = true;
  try {
    await jira.search(`project = ${project.key} AND fixVersion = "${name}"`, { limit: 1 });
  } catch (error) {
    if (!NOT_FOUND.test(String(error?.message))) throw error;
    found = false;
  }
  kv.set(ctx.db, cacheKey(project.key, name), { exists: found, at: now }, now);
  return found;
}

async function fixVersionNames(ctx, project, jira, version, now) {
  const wanted = [...new Set([version, ...(kv.get(ctx.db, namesKey(project.key, version)) ?? [])])];
  const present = [];
  for (const name of wanted) if (await exists(ctx, project, jira, name, now)) present.push(name);
  return present;
}

module.exports = { fixVersionNames, parseList, namesKey };
