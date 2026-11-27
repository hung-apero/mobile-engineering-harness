const path = require('node:path');
const { createJira } = require('./jira.cjs');
const { recordWould } = require('./effects.cjs');
const workspace = require('./workspace.cjs');
const merge = require('./merge.cjs');
const landing = require('./landing.cjs');
const diffGuard = require('./diff-guard.cjs');

function createBugs(ctx, { connect, timeoutMs } = {}) {
  const adapters = new Map();
  const bugs = {
    git: { workspace, merge, landing, diffGuard },
    advanceBatch: (...args) => require('./batch-machine.cjs').advanceBatch(...args),
    async jira(project) {
      const live = project.live === true;
      const id = `${project.key}:${live}`;
      if (!adapters.has(id)) {
        const configFile = path.join(ctx.secretsDir, 'jira-mcp.json');
        adapters.set(id, createJira({ configFile, live, record: recordWould(ctx, project), connect, timeoutMs }));
      }
      return adapters.get(id);
    },
    async closeAll() {
      const open = [...adapters.values()];
      adapters.clear();
      await Promise.allSettled(open.map(adapter => adapter.close()));
    },
  };
  return bugs;
}

module.exports = { createBugs };
