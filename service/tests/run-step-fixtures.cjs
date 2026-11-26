const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readEvents, summarize } = require('../src/stream-reader.cjs');

const RUN_STEP = path.join(__dirname, '..', 'src', 'run-step.cjs');
const SESSION = crypto.randomUUID();

function stepHome(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-step-')));
  const h = { dir, file: name => path.join(dir, name), read: name => fs.readFileSync(path.join(dir, name), 'utf8') };
  const pids = [];
  h.js = (code, extra = {}) => ({ name: 'bước', argv: [process.execPath, '-e', code], cwd: dir, timeoutMs: 20000, ...extra });
  h.spec = doc => {
    const file = h.file('spec.json');
    fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
    return file;
  };
  h.start = (specFile, { args = ['--session-id', SESSION], env = process.env } = {}) => {
    const out = fs.openSync(h.file('stream.jsonl'), 'w');
    const child = spawn(process.execPath, [RUN_STEP, specFile, ...args], { detached: true, env, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    pids.push(-child.pid);
    child.done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    return child;
  };
  h.summary = () => {
    const { events, bad } = readEvents(h.file('stream.jsonl'), 0);
    return { events, bad, ...summarize(events) };
  };
  h.run = async (doc, options) => {
    const end = await h.start(h.spec(doc), options).done;
    const summary = h.summary();
    return { ...end, ...summary, steps: summary.result && JSON.parse(summary.result.result).steps };
  };
  h.pid = name => {
    const pid = Number(h.read(name));
    pids.push(pid);
    return pid;
  };
  t.after(() => {
    for (const name of ['step', 'grand']) if (fs.existsSync(h.file(name))) h.pid(name);
    for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

module.exports = { stepHome, alive, RUN_STEP, SESSION };
