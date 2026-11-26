const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// One way to run Gradle for the harness. Output goes to a log file, never to pipes: on Windows a Gradle daemon
// started by this call inherits the handles, and spawnSync waits for pipes to close — so a build done in 6 minutes
// sat until the 40-minute timeout. With a file, spawnSync returns when gradlew exits.
const DAEMON_TROUBLE = /Could not connect to the Gradle daemon|Gradle build daemon disappeared|daemon.*(crashed|stopped)/i;
const TIMEOUT_MS = 40 * 60 * 1000;

// Tests point LEARN_APP_GRADLEW at a .js/.cjs fake so it runs under node (no shebang needed on Windows).
function gradlewCommand() {
  const override = process.env.LEARN_APP_GRADLEW;
  if (!override) return { command: './gradlew', prefixArgs: [] };
  if (/\.(js|cjs)$/.test(override)) return { command: process.execPath, prefixArgs: [override] };
  return { command: override, prefixArgs: [] };
}

const KEEP_LOGS = 20;

const PRUNE_AFTER_MS = 60 * 60 * 1000;

// Keeps the newest logs; never touches a log younger than an hour (another build may be writing or reading it).
function logDir() {
  const dir = path.join(os.tmpdir(), 'learn-app-gradle');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const logs = fs.readdirSync(dir).filter(n => n.endsWith('.log')).map(n => ({ file: path.join(dir, n), at: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    logs.slice(KEEP_LOGS).filter(l => Date.now() - l.at > PRUNE_AFTER_MS).forEach(l => fs.rmSync(l.file, { force: true }));
  } catch {}
  return dir;
}

function runOnce(dir, args, timeoutMs) {
  const { command, prefixArgs } = gradlewCommand();
  const logFile = path.join(logDir(), `gradle-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(logFile, 'w');
  let run;
  try {
    run = spawnSync(command, [...prefixArgs, ...args], { cwd: dir, stdio: ['ignore', fd, fd], timeout: timeoutMs, windowsHide: true });
    // Some Windows setups cannot start the sh wrapper: fall back to gradlew.bat through cmd (still no pipes).
    if (process.platform === 'win32' && command === './gradlew' && run.error && run.error.code === 'ENOENT') {
      run = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'gradlew.bat', ...args], { cwd: dir, stdio: ['ignore', fd, fd], timeout: timeoutMs, windowsHide: true });
    }
  } finally {
    fs.closeSync(fd);
  }
  return { run, logFile, log: fs.readFileSync(logFile, 'utf8') };
}

// { ok, log, logFile, timedOut, durationMs }. A daemon that died mid-build gets one more try.
function runGradle(dir, args, { timeoutMs = TIMEOUT_MS } = {}) {
  const started = Date.now();
  let out;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    out = runOnce(dir, args, timeoutMs);
    if (out.run.status === 0 || !DAEMON_TROUBLE.test(out.log)) break;
  }
  const { run, log, logFile } = out;
  const timedOut = Boolean(run.error && run.error.code === 'ETIMEDOUT');
  const failure = timedOut
    ? `Gradle chạy quá ${Math.round(timeoutMs / 60000)} phút nên bị dừng (log: ${logFile})`
    : run.error ? `Không chạy được Gradle: ${run.error.message}` : null;
  return { ok: run.status === 0, log: failure ? `${log}\n${failure}` : log, logFile, timedOut, durationMs: Date.now() - started };
}

module.exports = { runGradle, gradlewCommand, DAEMON_TROUBLE, TIMEOUT_MS };
