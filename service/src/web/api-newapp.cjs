const newapp = require('../newapp/index.cjs');
const { defaultDeps } = require('../newapp/default-deps.cjs');
const { invalid } = require('./web-error.cjs');

const TEXT = ['key', 'name', 'package', 'applicationId', 'repo', 'firebaseProjectId', 'testerGroup', 'jiraProject'];
const DISCORD = ['channelId', 'po', 'qa', 'devOnCall'];
const OPTIONAL = { ads: ['provided', 'temporary'], license: ['provided', 'temporary'], api: ['provided', 'temporary'] };

const text = value => (typeof value === 'string' ? value.trim() : '');

function appFrom(body) {
  const app = { discord: {}, optional: {}, signing: body.signing === 'dev-only' ? 'dev-only' : 'release' };
  for (const name of TEXT) app[name] = text(body[name]);
  for (const name of DISCORD) app.discord[name] = text(body[name]);
  for (const [name, allowed] of Object.entries(OPTIONAL)) if (allowed.includes(body[name])) app.optional[name] = body[name];
  return app;
}

async function guarded(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof newapp.NewAppError) throw invalid(error.message);
    throw error;
  }
}

function save({ ctx, body, now }) {
  return guarded(() => {
    const app = appFrom(body);
    newapp.start(ctx, app, now);
    return { key: app.key };
  });
}

function check({ ctx, body, now }) {
  return guarded(async () => {
    const { app } = newapp.status(ctx, text(body.key));
    const result = await newapp.verifyAll(ctx, app, now, ctx.newappDeps ?? defaultDeps(ctx));
    return { passed: result.ok, items: result.items };
  });
}

module.exports = { save, check };
