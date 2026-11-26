const fs = require('node:fs');
const path = require('node:path');
const { openStepLog, runAttempt, stopTree } = require('./step-process.cjs');
const { recordRunning, clearRunning, stopLeftover, markStarted } = require('./step-running.cjs');
const { readSpec, logName } = require('./step-spec.cjs');
const { redact, firstLine } = require('./redact.cjs');

const HEARTBEAT_MS = 45000;
const STREAM_MAX = 3800;
const STREAM_NAME = 60;
const STREAM_TAIL = 400;
const STREAM_ERROR = 300;
const STOPPED_CODE = 143;
const UNKNOWN = { ok: false, unknown: true, exitCode: null, signal: null, timedOut: false, attempts: 0, ms: 0, tail: 'bước chỉ được chạy một lần và lần trước đã bắt đầu, không rõ kết quả' };

const flat = text => redact(text.replace(/[\p{C}\p{Zl}\p{Zp}"\\]+/gu, ' ').trim());
const beat = text => ({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } });

async function runStep(step, { dir, file, state, emit, label, heartbeatMs }) {
  if (step.once && !markStarted(`${file}.started`)) return { name: step.name, ...UNKNOWN };
  const began = Date.now();
  const seconds = () => Math.round((Date.now() - began) / 1000);
  emit(beat(label));
  const timer = setInterval(() => emit(beat(`${label}: ${seconds()}s`)), heartbeatMs);
  const log = openStepLog(file);
  try {
    let attempts = 0;
    let last;
    do {
      last = await runAttempt(step, log, state, pid => recordRunning(dir, pid));
      if (last.stopped) clearRunning(dir);
      attempts++;
    } while (!last.ok && last.stopped && attempts <= step.retries);
    const { ok, exitCode, signal, timedOut } = last;
    return { name: step.name, ok, exitCode, signal, timedOut, attempts, ms: Date.now() - began, tail: log.tail() };
  } finally {
    clearInterval(timer);
    log.close();
  }
}

async function runSpec({ steps }, { dir, emit, state = { child: null, stopping: false }, heartbeatMs = HEARTBEAT_MS }) {
  const done = [];
  for (const [index, step] of steps.entries()) {
    const label = `[${index + 1}/${steps.length}] ${flat(step.name)}`;
    const result = await runStep(step, { dir, file: path.join(dir, logName(index, step.name)), state, emit, label, heartbeatMs });
    done.push(result);
    if (!result.ok) return { ok: false, steps: done };
  }
  return { ok: true, steps: done };
}

function streamText({ steps, error }) {
  const short = steps.map(step => ({ ...step, name: flat(step.name).slice(0, STREAM_NAME).toWellFormed(), tail: '' }));
  const doc = { steps: short, ...(error && { error: flat(error).slice(0, STREAM_ERROR).toWellFormed() }) };
  const last = short.at(-1);
  if (last && !last.ok) {
    const room = Math.max(0, Math.min(STREAM_TAIL, STREAM_MAX - JSON.stringify(doc).length));
    last.tail = room ? flat(steps.at(-1).tail).slice(-room).toWellFormed() : '';
  }
  return JSON.stringify(doc);
}

function writeResult(outFile, doc) {
  const temp = `${outFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(doc), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, outFile);
}

async function execute(specFile, sessionId, emit, state) {
  let outcome = { ok: false, steps: [] };
  try {
    const spec = readSpec(specFile);
    const dir = path.dirname(path.resolve(specFile));
    await stopLeftover(dir);
    fs.rmSync(spec.outFile, { force: true });
    outcome = await runSpec(spec, { dir, emit, state });
    writeResult(spec.outFile, { sessionId, ok: outcome.ok, steps: outcome.steps });
    return outcome;
  } catch (error) {
    return { ok: false, steps: outcome.steps, error: firstLine(error) };
  }
}

function parseArgs([specFile, flag, sessionId, ...rest]) {
  return specFile && flag === '--session-id' && sessionId && rest.length === 0 ? { specFile, sessionId } : null;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write('cách dùng: run-step.cjs <spec.json> --session-id <uuid>\n');
    return 2;
  }
  const { specFile, sessionId } = args;
  const state = { child: null, stopping: false };
  const emit = event => process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId })}\n`);
  const stop = async () => {
    if (state.stopping) return;
    state.stopping = true;
    if (state.child) await stopTree(state.child);
    process.exit(STOPPED_CODE);
  };
  process.stdout.on('error', () => {});
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
  emit({ type: 'system', subtype: 'init', cwd: process.cwd() });
  const outcome = await execute(specFile, sessionId, emit, state);
  emit({
    type: 'result', subtype: 'success', is_error: !outcome.ok, result: streamText(outcome),
    num_turns: outcome.steps.length, total_cost_usd: 0, permission_denials: [],
  });
  return outcome.ok ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code));

module.exports = { runSpec };
