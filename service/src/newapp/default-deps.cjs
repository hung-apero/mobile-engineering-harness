const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const TIMEOUT = 30000;
const ALIAS = /^[A-Za-z0-9_][\w .-]{0,127}$/;

function hasOwnKeyPassword(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return ['feedfeed', 'cececece'].includes(head.toString('hex'));
  } finally {
    fs.closeSync(fd);
  }
}

function keytoolCalls({ keystore, password, alias, keyPassword }) {
  if (typeof alias !== 'string' || !ALIAS.test(alias)) throw new Error('keyAlias không hợp lệ');
  const store = ['-keystore', keystore, '-alias', alias, '-storepass:env', 'DZ_NEWAPP_STOREPASS'];
  const env = { DZ_NEWAPP_STOREPASS: password, DZ_NEWAPP_KEYPASS: keyPassword };
  return [{ args: ['-list', ...store], env }, { args: ['-certreq', ...store, '-keypass:env', 'DZ_NEWAPP_KEYPASS'], env }];
}

function defaultDeps(ctx) {
  return {
    repo: {
      async lsRemote(repo) {
        const { stdout } = await run('git', ['ls-remote', `https://github.com/${repo}.git`], { timeout: TIMEOUT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        return stdout.split('\n').filter(Boolean).length;
      },
      async permissions(repo) {
        const { stdout } = await run('gh', ['api', `repos/${repo}`, '--jq', '.permissions'], { timeout: TIMEOUT });
        return JSON.parse(stdout);
      },
    },
    jira: {
      async search(jql, opts) {
        const { createJira } = require('../bugs/jira.cjs');
        const jira = createJira({ configFile: path.join(ctx.secretsDir, 'jira-mcp.json'), live: false, record: () => {} });
        try {
          return await jira.search(jql, opts);
        } finally {
          await jira.close();
        }
      },
    },
    keytool(options) {
      if (!hasOwnKeyPassword(options.keystore) && options.keyPassword !== options.password) throw new Error('keyPassword phải trùng storePassword với keystore PKCS12');
      for (const { args, env } of keytoolCalls(options)) execFileSync('keytool', args, { timeout: TIMEOUT, stdio: 'ignore', env: { ...process.env, ...env } });
    },
    harnessCommit() {
      const dir = path.join(ctx.dzHome, 'harness');
      try {
        return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        throw new Error(`không đọc được commit của harness ở ${dir}`);
      }
    },
  };
}

module.exports = { defaultDeps, keytoolCalls };
