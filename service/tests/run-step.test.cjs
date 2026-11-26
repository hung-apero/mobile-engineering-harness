const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { judgeDead } = require('../src/verdict.cjs');
const { runSpec } = require('../src/run-step.cjs');
const { stepHome, SESSION } = require('./run-step-fixtures.cjs');

const SECRET = `ghp_${'a'.repeat(36)}`;

test('steps run in order and the stream is judged done by the existing reader', async t => {
  const h = stepHome(t);
  const add = text => h.js(`require('fs').appendFileSync('order', '${text}')`, { name: text });
  const r = await h.run({ steps: [add('một'), add('hai')] });
  assert.equal(r.code, 0);
  assert.equal(r.bad, 0);
  assert.equal(h.read('order'), 'mộthai');
  assert.deepEqual(r.events.map(e => [e.type, e.subtype]), [['system', 'init'], ['assistant', undefined], ['assistant', undefined], ['result', 'success']]);
  assert.ok(r.events.every(e => e.session_id === SESSION));
  assert.equal(r.answered, true);
  const verdict = judgeDead(r, { command: true });
  assert.equal(verdict.type, 'done');
  assert.deepEqual(JSON.parse(verdict.result.text).steps.map(s => [s.name, s.ok, s.exitCode, s.signal, s.timedOut, s.attempts]), [['một', true, 0, null, false, 1], ['hai', true, 0, null, false, 1]]);
  assert.ok(r.steps.every(s => s.ms >= 0));
});

test('the first failed step stops the run with exit code 1 and an error result', async t => {
  const h = stepHome(t);
  const r = await h.run({ steps: [h.js("console.log('lỗi biên dịch'); process.exit(7)", { name: 'a' }), h.js("require('fs').writeFileSync('second', '')")] });
  assert.equal(r.code, 1);
  assert.deepEqual([r.result.subtype, r.result.is_error], ['success', true]);
  assert.deepEqual(r.steps.map(s => [s.ok, s.exitCode, s.attempts]), [[false, 7, 1]]);
  assert.match(r.steps[0].tail, /lỗi biên dịch/);
  assert.equal(fs.existsSync(h.file('second')), false);
  assert.equal(judgeDead(r, { command: true }).type, 'failed');
});

test('a failing step is retried and passes on the last allowed attempt', async t => {
  const h = stepHome(t);
  const code = "const fs = require('fs'); fs.appendFileSync('n', 'x'); console.log('lần ' + fs.readFileSync('n').length); process.exit(fs.readFileSync('n').length < 3 ? 1 : 0)";
  const pass = await h.run({ steps: [h.js(code, { retries: 2 })] });
  assert.deepEqual([pass.code, pass.steps[0].ok, pass.steps[0].attempts], [0, true, 3]);
  assert.match(h.read('0-b-c.log'), /lần 1[\s\S]*lần 2[\s\S]*lần 3/);
  fs.rmSync(h.file('n'));
  const fail = await h.run({ steps: [h.js(code, { retries: 1 })] });
  assert.deepEqual([fail.code, fail.steps[0].ok, fail.steps[0].attempts], [1, false, 2]);
});

test('arguments are passed without a shell', async t => {
  const h = stepHome(t);
  const r = await h.run({ steps: [h.js("require('fs').writeFileSync('arg', process.argv[1])", { argv: [process.execPath, '-e', "require('fs').writeFileSync('arg', process.argv[1])", '$(touch hacked); *'] })] });
  assert.equal(r.code, 0);
  assert.equal(h.read('arg'), '$(touch hacked); *');
  assert.equal(fs.existsSync(h.file('hacked')), false);
});

test('output goes to a private log named from the index and the cleaned name, never to the stream', async t => {
  const h = stepHome(t);
  const r = await h.run({ steps: [h.js("console.log('ra ngoài'); console.error('ra lỗi')", { name: '../x/y z' })] });
  const log = h.file('0-x-y-z.log');
  assert.match(fs.readFileSync(log, 'utf8'), /ra ngoài[\s\S]*ra lỗi|ra lỗi[\s\S]*ra ngoài/);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.equal(r.bad, 0);
});

test('a step log stops growing at 20 MB while the tail keeps the end', async t => {
  const h = stepHome(t);
  const r = await h.run({ steps: [h.js("const b = 'x'.repeat(1024 * 1024); for (let i = 0; i < 25; i++) require('fs').writeSync(1, b); console.log('hết')", { name: 'a' })] });
  assert.equal(r.code, 0);
  assert.equal(fs.statSync(h.file('0-a.log')).size, 20 * 1024 * 1024);
  assert.match(JSON.parse(h.read('result.json')).steps[0].tail, /hết\s*$/);
});

test('result.json keeps 4000 redacted characters of each tail, the stream stays parseable inside the 4000 character limit', async t => {
  const h = stepHome(t);
  const code = `console.log('đ\\n"\\\\'.repeat(5000) + '\\t@mail.example.com ${SECRET} cuối'); process.exit(Number(process.argv[1]))`;
  const steps = Array.from({ length: 20 }, (_, i) => h.js(code, { name: `bước "${i}" ${'x'.repeat(50)}`, argv: [process.execPath, '-e', code, i === 19 ? '1' : '0'] }));
  const r = await h.run({ steps });
  const { result } = judgeDead(r, { command: true });
  const parsed = JSON.parse(result.text);
  assert.deepEqual([parsed.steps.length, parsed.steps[18].ok, parsed.steps[19].ok], [20, true, false]);
  const full = JSON.parse(h.read('result.json'));
  assert.deepEqual([full.sessionId, full.ok, full.steps.length], [SESSION, false, 20]);
  assert.ok(full.steps.every(s => s.tail.length === 4000 && s.tail.includes('cuối')));
  assert.equal(`${h.read('result.json')}${h.read('stream.jsonl')}`.includes(SECRET), false);
  assert.equal(fs.statSync(h.file('result.json')).mode & 0o777, 0o600);
});

test('outFile replaces result.json and an old one never survives into a new run', async t => {
  const h = stepHome(t);
  fs.writeFileSync(h.file('out.json'), 'cũ');
  const r = await h.run({ outFile: 'out.json', steps: [h.js("if (require('fs').existsSync('out.json')) process.exit(9)")] });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(h.read('out.json')).ok, true);
  assert.deepEqual(fs.readdirSync(h.dir).filter(n => /result\.json|tmp/.test(n)), []);
});

test('a step sees its own env and cannot get a protected variable back', async t => {
  const h = stepHome(t);
  const code = "require('fs').writeFileSync('env', JSON.stringify([process.env.A, process.env.GH_TOKEN, process.env.DZ_T, process.env.LEARN_APP_BUILD_SLOTS]))";
  const env = { ...process.env, LEARN_APP_BUILD_SLOTS: '1', DZ_T: 't' };
  delete env.GH_TOKEN;
  await h.run({ steps: [h.js(code, { env: { A: 'a', GH_TOKEN: 'x', DZ_T: null, LEARN_APP_BUILD_SLOTS: '9' } })] }, { env });
  assert.deepEqual(JSON.parse(h.read('env')), ['a', null, null, '1']);
});

test('a command or folder that does not exist is a failed step with the reason', async t => {
  const h = stepHome(t);
  for (const bad of [{ argv: ['/no/such/tool'] }, { cwd: '/no/such/dir' }]) {
    const r = await h.run({ steps: [h.js('', bad)] });
    assert.deepEqual([r.code, r.steps[0].ok, r.steps[0].exitCode], [1, false, null]);
    assert.match(r.steps[0].tail, /ENOENT/);
  }
});

test('a spec that is missing, not a regular file or invalid ends with an error result and no step run', async t => {
  const h = stepHome(t);
  const ok = h.js('');
  const bad = ['{', '[]', {}, { steps: [] }, { steps: Array(21).fill(ok) }, ...[
    { name: '' }, { argv: [] }, { argv: 'ls' }, { argv: ['ls', 1] }, { cwd: 'relative' }, { timeoutMs: 0 }, { timeoutMs: 2 ** 31 }, { retries: -1 }, { env: { A: 1 } },
  ].map(extra => ({ steps: [{ ...ok, ...extra }] })), { steps: [ok], outFile: 'spec.json' }];
  for (const doc of bad) {
    const r = await h.run(doc);
    assert.deepEqual([r.code, r.result.is_error, r.steps], [1, true, []], JSON.stringify(doc));
    assert.ok(JSON.parse(r.result.result).error);
    assert.equal(judgeDead(r, { command: true }).type, 'failed');
  }
  fs.renameSync(h.spec({ steps: [ok] }), h.file('real.json'));
  fs.symlinkSync(h.file('real.json'), h.file('link.json'));
  for (const file of [h.file('link.json'), h.dir, h.file('none.json')]) {
    assert.equal((await h.start(file).done).code, 1);
    assert.equal(h.summary().result.is_error, true);
  }
});

test('without a session id nothing runs', async t => {
  const h = stepHome(t);
  const r = await h.run({ steps: [h.js("require('fs').writeFileSync('ran', '')")] }, { args: [] });
  assert.deepEqual([r.code, r.result, fs.existsSync(h.file('ran'))], [2, null, false]);
});

test('a running step beats regularly', async t => {
  const h = stepHome(t);
  const events = [];
  const spec = { steps: [{ name: 'a', argv: [process.execPath, '-e', 'setTimeout(() => {}, 1000)'], cwd: h.dir, timeoutMs: 20000, retries: 0, env: {} }] };
  const { ok } = await runSpec(spec, { dir: h.dir, emit: e => events.push(e), heartbeatMs: 100 });
  assert.equal(ok, true);
  assert.ok(events.length >= 4, String(events.length));
  assert.ok(events.every(e => e.type === 'assistant' && e.parent_tool_use_id === null));
});

test('a background process that keeps the output open does not hold the step', async t => {
  const h = stepHome(t);
  const code = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); require('fs').writeFileSync('pid', String(c.pid)); c.unref()";
  const began = Date.now();
  const r = await h.run({ steps: [h.js(code)] });
  h.pid('pid');
  assert.equal(r.code, 0);
  assert.ok(Date.now() - began < 10000);
});
