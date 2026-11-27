const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jobs = require('./jobs.cjs');
const kv = require('./kv.cjs');
const { pathsFor } = require('./bugs/git.cjs');
const { isCommandKind } = require('./slots.cjs');
const { profileText, real, within } = require('./sandbox-profile.cjs');
const { findBin, executable } = require('./find-bin.cjs');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const CODE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PORT = '8787';
const IDLE_SECONDS = 600;
const OPEN = ['starting', 'running'];

const binOf = ctx => ctx.sandboxBin ?? SANDBOX_EXEC;
const runsDir = dzHome => path.join(dzHome, 'runs');

function sandboxState({ env = {}, sandboxBin }) {
  if (env.DZ_SANDBOX === 'off') return 'off';
  return executable(binOf({ sandboxBin })) ? 'on' : 'missing';
}

const refuses = (ctx, project) => project.live === true && sandboxState(ctx) === 'missing';

function webPorts(ctx) {
  let running = '';
  try {
    running = new URL(kv.get(ctx.db, 'web:url')).port;
  } catch {}
  return [...new Set([ctx.env.DZ_WEB_PORT || DEFAULT_PORT, running])].filter(port => /^[1-9]\d{0,4}$/.test(port));
}

function writable(dzHome, job, { cwd, command }) {
  const dir = real(cwd);
  const dirs = isCommandKind(job.kind) ? [dir, path.dirname(real(String(command?.args?.at?.(-1) ?? cwd)))] : [dir, `${dir}-worktrees`];
  return dirs.filter(target => within(target, path.join(dzHome, 'workspaces')) || target === path.join(dzHome, 'probe'));
}

function freshRun(dzHome, jobId) {
  const dir = path.join(runsDir(dzHome), String(jobId));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(path.join(dir, 'work'), { recursive: true, mode: 0o700 });
  return dir;
}

const writePrivate = (file, text) => fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });

function privateMcp(dzHome, runDir, file) {
  if (!file || !within(real(file), path.join(dzHome, 'secrets'))) return file;
  const copy = path.join(runDir, 'mcp.json');
  writePrivate(copy, fs.readFileSync(file));
  return copy;
}

function gradleOpts(env, work) {
  const options = [
    `-Dorg.gradle.daemon.registry.base=${path.join(work, 'gradle')}`,
    `-Dorg.gradle.daemon.idletimeout=${IDLE_SECONDS * 1000}`,
    `-Dkotlin.daemon.options=runFilesPath=${path.join(work, 'kotlin')},autoshutdownIdleSeconds=${IDLE_SECONDS}`,
  ].map(option => (/\s/.test(option) ? `"${option}"` : option));
  return [env.GRADLE_OPTS, ...options].filter(Boolean).join(' ');
}

function contain(ctx, job, project, prepared, env) {
  const state = sandboxState(ctx);
  if (refuses(ctx, project)) throw new Error('máy thiếu sandbox-exec, project live không được mở việc');
  if (state !== 'on') return { env, mcpConfig: prepared.mcpConfig };
  const dzHome = real(ctx.dzHome);
  const home = real(os.homedir());
  const agent = !isCommandKind(job.kind);
  const runDir = freshRun(dzHome, job.id);
  const work = path.join(runDir, 'work');
  const mcpConfig = privateMcp(dzHome, runDir, prepared.mcpConfig);
  const gradleDir = real(env.GRADLE_USER_HOME || path.join(home, '.gradle'));
  const profile = path.join(runDir, 'profile.sb');
  writePrivate(profile, profileText({
    home, dzHome, runDir, mcpConfig, gradleDir, agent,
    codeRoot: real(CODE_ROOT),
    shared: !env.CLAUDE_CONFIG_DIR,
    claudeDir: real(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')),
    writes: writable(dzHome, job, prepared),
    mirror: job.kind === 'bug' ? pathsFor({ dzHome, project }).mirror : null,
    ports: webPorts(ctx),
    searchPath: ctx.env.PATH ?? '',
    bins: [process.execPath, findBin(ctx.claudeBin, { searchPath: ctx.env.PATH })].filter(Boolean),
  }));
  return { env: { ...env, GRADLE_OPTS: gradleOpts(env, work) }, mcpConfig, sandbox: { bin: binOf(ctx), profile } };
}

function pruneRuns(ctx) {
  const dir = runsDir(ctx.dzHome);
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const name of fs.readdirSync(dir).filter(entry => /^\d+$/.test(entry))) {
    if (OPEN.includes(jobs.getJob(ctx.db, Number(name))?.state)) continue;
    fs.rmSync(path.join(dir, name, 'mcp.json'), { force: true });
    fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 5 });
  }
}

const SHOWN = { on: 'bật', off: 'TẮT theo DZ_SANDBOX=off, worker không bị giới hạn', missing: 'THIẾU sandbox-exec, project live không mở việc' };
const sandboxLine = ctx => SHOWN[sandboxState(ctx)];

module.exports = { contain, refuses, pruneRuns, sandboxState, sandboxLine, SANDBOX_EXEC };
