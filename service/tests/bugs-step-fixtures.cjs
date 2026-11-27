const { createFakeJira } = require('./fixtures/fake-jira.cjs');
const { createBugs } = require('../src/bugs/wire.cjs');
const { loadProjects } = require('../src/projects.cjs');
const store = require('../src/bugs/store.cjs');
const polling = require('../src/bugs/polling.cjs');
const { makeHome } = require('./service-fixtures.cjs');

const MIN = 60000;
const NOW = Date.parse('2026-11-26T10:00:00+07:00');
const issue = (status = 'To Do', extra = {}) => ({ status, priority: 'High', transitions: [], ...extra });

function setup(t, { issues = {}, live = false, keys = ['ABC1'], advance } = {}) {
  const h = makeHome(t, keys);
  for (const key of keys) h.project(key, { live });
  const ctx = h.context();
  const fake = createFakeJira({ issues });
  const advances = [];
  ctx.bugs = Object.assign(createBugs(ctx, { connect: fake.connect }), {
    advanceBatch: async (_, args) => {
      advances.push(args);
      return advance ? advance(args) : { changed: false };
    },
  });
  const config = () => ({ projects: loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome }).projects, base: ctx.rulesFor() });
  ctx.bugs.baseContains = async () => ({ ok: false, detail: 'test' });
  const searches = () => fake.calls.filter(call => call.name === 'jira_search' && call.args.jql.includes('ORDER BY'));
  const turnOn = (project = 'ABC1', version = '1.9.2', at = NOW - 2 * MIN) => {
    store.ensureVersion(ctx.db, { project, version });
    return polling.setPolling(ctx.db, project, version, true, at);
  };
  return { h, ctx, fake, advances, config, searches, turnOn };
}

module.exports = { setup, issue, NOW, MIN, makeHome };
