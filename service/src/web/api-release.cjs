const store = require('../bugs/store.cjs');
const { loadProjects } = require('../projects.cjs');
const { deferTickets, DeferError } = require('../bugs/defer.cjs');
const { WebError, invalid } = require('./web-error.cjs');

async function defer({ ctx, params: [key, name], body, now }) {
  const project = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome }).projects.get(key);
  const version = project ? store.getVersion(ctx.db, key, name) : null;
  if (!version) throw new WebError(404, 'NOT_FOUND', 'Không có bản này.');
  try {
    return await deferTickets(ctx, project, version, { keys: body.keys, by: body.by, source: 'web' }, now);
  } catch (error) {
    if (error instanceof DeferError) throw invalid(error.message);
    throw error;
  }
}

module.exports = { defer };
