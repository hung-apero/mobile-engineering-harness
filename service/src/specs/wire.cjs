const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createConfluence } = require('./confluence.cjs');
const { prepareSpecClone } = require('./clone.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { runGit } = require('../bugs/git.cjs');
const { isolatedEnv, IDENTITY } = require('../bugs/prompts-env.cjs');
const { workerEnv, applyEnv } = require('../worker-env.cjs');
const { firstLine } = require('../redact.cjs');

const CHECK_TIMEOUT_MS = 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;
const GIT_CONFIG = [['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false'], ['commit.gpgSign', 'false'], ['core.attributesFile', '/dev/null']];
const KNOWN_CONFIG = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode)|remote\.origin\.(?:url|fetch|tagopt)|branch\..+\.(?:remote|merge)|user\.(?:name|email))$/i;

async function checkRepo(repo) {
  if (!fs.lstatSync(path.join(repo, '.git')).isDirectory()) throw new Error('.git của bản clone spec không phải thư mục thật');
  const { stdout } = await runGit(['config', '--local', '--name-only', '--list', '-z'], { cwd: repo });
  const odd = stdout.split('\0').filter(Boolean).find(name => !KNOWN_CONFIG.test(name));
  if (odd) throw new Error(`bản clone spec có cấu hình git lạ: ${odd}`);
}

const harnessError = message => Object.assign(new Error(message), { code: 'HARNESS' });

function checkEnv(ctx) {
  return applyEnv(workerEnv(ctx.env, ctx.dzHome), { ...isolatedEnv(ctx.dzHome, { config: GIT_CONFIG }), ...IDENTITY });
}

function createSpecs(ctx, { connect, checker = null, python = 'python3' } = {}) {
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
    async check(project, repo, segment) {
      await checkRepo(repo);
      const script = checker ?? path.join(ctx.dzHome, 'harness', 'skills', 'feature', 'scripts', 'headless_check.py');
      if (!fs.lstatSync(script, { throwIfNoEntry: false })?.isFile()) throw harnessError(`harness ghim thiếu ${script}`);
      return new Promise((resolve, reject) => {
        execFile(python, ['-I', script, segment, repo], { cwd: repo, env: checkEnv(ctx), timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
          const code = error ? error.code : 0;
          if (code === 'ENOENT') return reject(harnessError(`không chạy được ${python}`));
          if (code !== 0 && code !== 2) return reject(new Error(`headless_check lỗi: ${firstLine(stderr || error?.message || String(code))}`));
          try {
            const out = JSON.parse(stdout);
            resolve({ ok: out.ok === true, problems: Array.isArray(out.problems) ? out.problems.map(String) : [], blocked: out.blocked ?? null });
          } catch {
            reject(new Error('headless_check trả kết quả không phải JSON'));
          }
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
