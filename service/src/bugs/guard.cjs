const { logChanged } = require('../service-log.cjs');
const { firstLine } = require('../redact.cjs');

async function guard(ctx, project, name, fn) {
  try {
    const result = await fn();
    logChanged(ctx, `${name}:${project.key}`, null);
    return result;
  } catch (error) {
    logChanged(ctx, `${name}:${project.key}`, { project: project.key, error: firstLine(error) }, `${name.split(':')[0]}-error`);
    return null;
  }
}

module.exports = { guard };
