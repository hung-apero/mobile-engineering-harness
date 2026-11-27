const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('./db.cjs');
const { createRuleStore } = require('./rules.cjs');
const { defaultDeps } = require('./supervisor.cjs');
const { startWorker } = require('./worker.cjs');
const { sendDiscord } = require('./discord.cjs');
const { freeGb } = require('./health.cjs');
const { createServiceLog } = require('./service-log.cjs');
const { createBugs } = require('./bugs/wire.cjs');
const { createSpecs } = require('./specs/wire.cjs');
const { featuresPending, approvedSpec } = require('./specs/release-hooks.cjs');
const { createFacade } = require('./specs/facade.cjs');
const { createDiscordBot } = require('./discord-bot.cjs');
const { createDeskManager } = require('./desk.cjs');

const PRIVATE = ['.', 'secrets', 'logs'];
const SUBDIRS = ['logs', 'secrets', 'projects', 'workspaces', 'probe', 'bug-fix-state'];

function resolvePaths(env = process.env) {
  const dzHome = path.resolve(env.DZ_HOME || path.join(os.homedir(), '.dev-zone'));
  return {
    dzHome,
    rulesDir: path.resolve(env.DZ_RULES_DIR || path.join(__dirname, '..', 'rules')),
    projectsDir: path.join(dzHome, 'projects'),
    secretsDir: path.join(dzHome, 'secrets'),
    dbFile: path.join(dzHome, 'dz.db'),
    lockFile: path.join(dzHome, 'service.lock'),
    logFile: path.join(dzHome, 'logs', 'service.jsonl'),
  };
}

function ensureHome(dzHome) {
  for (const dir of [dzHome, ...SUBDIRS.map(name => path.join(dzHome, name))]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  for (const name of PRIVATE) fs.chmodSync(path.join(dzHome, name), 0o700);
}

function createContext(env = process.env) {
  const paths = resolvePaths(env);
  ensureHome(paths.dzHome);
  const ruleStore = createRuleStore(paths.rulesDir);
  const ctx = {
    ...paths,
    env,
    db: openDb(paths.dbFile),
    log: createServiceLog(paths.logFile),
    ruleStore,
    rulesFor: project => ruleStore.get(project),
    deps: defaultDeps(paths.dzHome),
    handlers: {
      probe: require('./handlers/probe.cjs'),
      bug: require('./handlers/bug.cjs'),
      review: require('./handlers/review.cjs'),
      gate: require('./handlers/gate.cjs'),
      build: require('./handlers/build.cjs'),
      spec: require('./handlers/spec.cjs'),
      explain: require('./handlers/explain.cjs'),
      uidiff: require('./handlers/uidiff.cjs'),
      e2e: require('./handlers/e2e.cjs'),
    },
    claudeBin: env.DZ_CLAUDE_BIN || 'claude',
    startWorker,
    send: sendDiscord,
    freeGb,
    seen: new Map(),
    repeats: new Map(),
    lastTickAt: null,
    wakeAt: 0,
    boot: true,
    stopping: false,
    bugStepPending: null,
    specStepPending: null,
    boardStepPending: null,
    deskStepPending: null,
  };
  ctx.bugs = createBugs(ctx);
  ctx.specs = createSpecs(ctx);
  ctx.bugs.featuresPending = (project, version) => featuresPending(ctx.db, project, version);
  ctx.e2e = { approvedSpec: project => approvedSpec(ctx, project) };
  ctx.facade = createFacade(ctx);
  ctx.deskBot = createDiscordBot({
    tokenFile: path.join(paths.secretsDir, 'discord-bot-token'),
    would: ({ channelId }) => ctx.log('would', { action: 'discord-reply', channelId }),
  });
  ctx.desk = createDeskManager({ db: ctx.db, dzHome: paths.dzHome, bot: ctx.deskBot, env, claudeBin: ctx.claudeBin, log: (event, fields) => ctx.log(event, fields), isStopping: () => ctx.stopping });
  return ctx;
}

module.exports = { resolvePaths, ensureHome, createContext };
