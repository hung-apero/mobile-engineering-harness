#!/usr/bin/env node
const fs = require('fs');
const { runGradle } = require('../lib/gradle-run.cjs');
const { withSlot } = require('../lib/slot-lock.cjs');
const { parseBuildErrors } = require('../lib/gradle-output.cjs');
const { appendJsonl } = require('../lib/tracking.cjs');
const S = require('../lib/learn-app-state.cjs');
const { fail, print, option } = require('../lib/cli-io.cjs');

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function recordBuild(dir, entry) {
  const appRoot = S.findAppRoot(dir);
  if (!appRoot) return;
  let step = null;
  try { step = S.readState(appRoot).step; } catch {}
  const plan = /^merge (\S+)/.exec(entry.label || '');
  appendJsonl(appRoot, 'build.jsonl', { at: new Date().toISOString(), step, plan: plan ? plan[1] : null, ...entry });
}

function gradleFlags() {
  const flags = ['--build-cache', '--console=plain', '--parallel'];
  if (process.env.LEARN_APP_CONFIG_CACHE === '1') flags.push('--configuration-cache');
  return flags;
}

function runBuild(dir, tasks, { root, label } = {}) {
  const errorRoot = root || dir;
  const requestedAt = Date.now();
  return withSlot('build', { label, onWait: waiters => console.error(`đang chờ build khác xong: ${waiters.join(', ')}`) }, () => {
    const started = Date.now();
    const queueWaitMs = started - requestedAt;
    const result = runGradle(dir, [...tasks, ...gradleFlags()]);
    const durationMs = Date.now() - started;
    recordBuild(errorRoot, { tasks, durationMs, queueWaitMs, ok: result.ok, label });
    return {
      log: result.log,
      ok: result.ok,
      timedOut: result.timedOut,
      logFile: result.logFile,
      durationMs,
      queueWaitMs,
      errors: parseBuildErrors(result.log, errorRoot),
      tail: result.log.split('\n').slice(-20),
    };
  });
}

function variantOf(dir) {
  const appRoot = S.findAppRoot(dir);
  return (appRoot ? S.readState(appRoot).buildVariant : null) || 'devDebug';
}

function assembleTasks(dir) {
  return [`:app:assemble${capitalize(variantOf(dir))}`];
}

// Compiles the whole app (feature modules included) without packaging/R8 — catches Kotlin + source errors fast.
function compileTasks(dir) {
  return [`:app:compile${capitalize(variantOf(dir))}Sources`];
}

function defaultTasks(dir) {
  return assembleTasks(dir);
}

function main() {
  const dir = option('root');
  if (!dir) fail('Thiếu --root <thư mục app>');
  if (!fs.existsSync(dir)) fail(`Không thấy thư mục ${dir}`);
  const tasksOption = option('tasks');
  const tasks = tasksOption
    ? tasksOption.split(/\s+/).filter(Boolean)
    : (option('mode') === 'compile' ? compileTasks(dir) : assembleTasks(dir));
  const result = runBuild(dir, tasks, { root: dir });
  const output = { ok: result.ok, durationMs: result.durationMs, tasks, errors: result.errors, log: result.logFile, ...(result.timedOut ? { timedOut: true } : {}) };
  if (!result.ok) output.tail = result.tail;
  print(output);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    fail(`build gặp lỗi: ${`${error.stderr || ''}`.trim().split('\n')[0] || error.message}`);
  }
}

module.exports = { runBuild, defaultTasks, assembleTasks, compileTasks, capitalize };
