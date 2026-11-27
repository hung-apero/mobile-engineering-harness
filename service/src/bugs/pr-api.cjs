const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { runGh, check } = require('./git.cjs');

const REPO = /^\w[\w.-]*\/\w[\w.-]*$/;
const PER_PAGE = 100;
const MAX_PAGES = 5;

function log(ctx, project, action, evidence, now) {
  record(ctx.db, { project: project.key, code: 'F06', ruleVersion: ruleVersionOf(ctx, project.key), evidence, action }, now);
}

async function api(ctx, project, route) {
  const { stdout } = await (ctx.bugs.gh ?? runGh)(['api', '--method', 'GET', `repos/${check(REPO, project.repo, 'repo')}/${route}`], { cwd: ctx.dzHome });
  return JSON.parse(stdout);
}

async function pages(ctx, project, route) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await api(ctx, project, `${route}?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(rows)) throw new Error('gh trả về không phải danh sách');
    all.push(...rows);
    if (rows.length < PER_PAGE) break;
  }
  return all;
}

module.exports = { log, api, pages };
