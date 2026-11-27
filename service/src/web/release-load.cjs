const store = require('../bugs/store.cjs');
const { loadProjects } = require('../projects.cjs');
const { WebError } = require('./web-error.cjs');
const { firstLine } = require('../redact.cjs');

async function loadRelease(ctx, [key, name], now, fresh) {
  const { releaseStatus, deferList } = require('../release-commands.cjs');
  const project = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome }).projects.get(key);
  const version = project ? store.getVersion(ctx.db, key, name) : null;
  if (!version) throw new WebError(404, 'NOT_FOUND', 'Không có bản này.');
  let problem = null;
  let status;
  let open = null;
  if (fresh) {
    try {
      status = await releaseStatus(ctx, project, version, now);
      open = await deferList(ctx, project, version, now);
    } catch (error) {
      problem = firstLine(error);
    }
  }
  status ??= await releaseStatus(ctx, project, version, now, { fresh: false });
  return { status, open, problem, fresh };
}

module.exports = { loadRelease };
