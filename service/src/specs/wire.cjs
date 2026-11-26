const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createConfluence } = require('./confluence.cjs');
const { prepareSpecClone } = require('./clone.cjs');
const { STATE_CLI } = require('./prompts.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { runGit } = require('../bugs/git.cjs');
const { isolatedEnv, IDENTITY } = require('../bugs/prompts-env.cjs');
const { workerEnv, applyEnv } = require('../worker-env.cjs');

const TIMEOUT_MS = 2 * 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const GIT_CONFIG = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['commit.gpgSign', 'false'], ['core.attributesFile', '/dev/null']];
const KNOWN_CONFIG = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(?:url|fetch|tagopt)|branch\..+\.(?:remote|merge)|user\.(?:name|email))$/i;

async function checkRepo(repo) {
  if (!fs.lstatSync(path.join(repo, '.git')).isDirectory()) throw new Error('.git của bản clone spec không phải thư mục thật');
  const { stdout } = await runGit(['config', '--local', '--name-only', '--list', '-z'], { cwd: repo });
  const odd = stdout.split('\0').filter(Boolean).find(name => !KNOWN_CONFIG.test(name));
  if (odd) throw new Error(`bản clone spec có cấu hình git lạ: ${odd}`);
}

function stateEnv(ctx, project, headless) {
  const overrides = { ...isolatedEnv(ctx.dzHome, { config: GIT_CONFIG }), ...IDENTITY, LEARN_APP_HEADLESS: headless ? '1' : null, LEARN_APP_TRACKING: project.live === true ? null : 'off' };
  return applyEnv(workerEnv(ctx.env, ctx.dzHome), overrides);
}

function createSpecs(ctx, { connect, cli = STATE_CLI } = {}) {
  const adapters = new Map();
  return {
    busy: new Set(),
    errors: new Map(),
    prepareClone: prepareSpecClone,
    confluence(project) {
      const live = project.live === true;
      const id = `${project.key}:${live}`;
      if (!adapters.has(id)) {
        const configFile = path.join(ctx.secretsDir, 'confluence-read.json');
        adapters.set(id, createConfluence({ configFile, live, record: recordWould(ctx, project), connect }));
      }
      return adapters.get(id);
    },
    async runState(project, repo, args, { headless = false } = {}) {
      await checkRepo(repo);
      return new Promise(resolve => {
        execFile(process.execPath, [cli, ...args], { cwd: repo, env: stateEnv(ctx, project, headless), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
          const code = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
          resolve({ code, stdout, stderr: stderr || (error && !Number.isInteger(error.code) ? error.message.split('\n')[0] : '') });
        });
      });
    },
    async closeAll() {
      const open = [...adapters.values()];
      adapters.clear();
      await Promise.allSettled(open.map(adapter => adapter.close()));
    },
  };
}

module.exports = { createSpecs, checkRepo };
