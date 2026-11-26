const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepare, judgeGate } = require('../src/handlers/gate.cjs');
const { lastResultText } = require('../src/bugs/result.cjs');
const { readSpec } = require('../src/step-spec.cjs');
const { SHA, setup, same } = require('./handlers-fixtures.cjs');

const MIN = 60000;
const CHANGED = ['app/src/main/java/a/Foo.kt', 'app/src/main/res/values/strings.xml'];

function world(t) {
  const w = setup(t);
  w.project.commands.lint = ['./gradlew', 'lintX'];
  const payload = { batchId: '7', worktree: w.repo, sha: SHA, changedFiles: CHANGED };
  const run = (extra = {}) => prepare({ payload: { ...payload, ...extra } }, { dzHome: w.dzHome, project: w.project });
  const dir = path.join(w.dzHome, 'workspaces', 'AAP864', 'batches', '7', `gate-${SHA.slice(0, 12)}`);
  return { ...w, run, dir };
}

test('the spec runs compile, unit tests and lint in that order inside the worktree', t => {
  const { run, dir, repo } = world(t);
  const out = run();
  const spec = path.join(dir, 'spec.json');
  assert.deepEqual(out.command, { bin: process.execPath, args: [path.join(__dirname, '..', 'src', 'run-step.cjs'), spec] });
  assert.equal(out.cwd, repo);
  const { steps } = readSpec(spec);
  assert.deepEqual(steps.map(s => [s.name, s.argv, s.cwd, s.timeoutMs, s.retries]), [
    ['compile', ['./gradlew', 'compileX'], repo, 45 * MIN, 0],
    ['unitTest', ['./gradlew', 'testX'], repo, 60 * MIN, 0],
    ['lint', ['./gradlew', 'lintX'], repo, 30 * MIN, 0],
  ]);
  assert.equal(fs.statSync(spec).mode & 0o777, 0o600);
});

test('a project without a lint command has no lint step', t => {
  const { run, dir, project } = world(t);
  delete project.commands.lint;
  run();
  assert.deepEqual(readSpec(path.join(dir, 'spec.json')).steps.map(s => s.name), ['compile', 'unitTest']);
});

test('preparing again rewrites the same spec and leaves no other file', t => {
  const { run, dir } = world(t);
  const first = run();
  const text = fs.readFileSync(path.join(dir, 'spec.json'), 'utf8');
  assert.ok(same(first, run()));
  assert.equal(fs.readFileSync(path.join(dir, 'spec.json'), 'utf8'), text);
  assert.deepEqual(fs.readdirSync(dir), ['spec.json']);
});

test('the gate has no GitHub, Firebase, Jira or ssh credentials', t => {
  const { run, dzHome } = world(t);
  const { env } = run();
  assert.equal(env.GH_CONFIG_DIR, path.join(dzHome, 'empty-gh'));
  for (const name of ['FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'JIRA_API_TOKEN', 'GIT_DIR']) assert.equal(env[name], null, name);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
});

test('a bad sha, batch id or a worktree outside the project is refused', t => {
  const { run, dzHome } = world(t);
  const link = path.join(dzHome, 'workspaces', 'AAP864', 'link');
  fs.symlinkSync(dzHome, link);
  for (const extra of [{ sha: 'abc' }, { batchId: '..' }, { worktree: dzHome }, { worktree: 'x' }, { worktree: link }, { changedFiles: 'x' }, { changedFiles: [1] }]) {
    assert.throws(() => run(extra), undefined, JSON.stringify(extra));
  }
});

test('a spec folder that is a symlink is refused', t => {
  const { run, dir, dzHome } = world(t);
  fs.symlinkSync(dzHome, dir);
  assert.throws(() => run());
  assert.equal(fs.existsSync(path.join(dzHome, 'spec.json')), false);
});

const step = (name, ok = true, extra = {}) => ({ name, ok, exitCode: ok ? 0 : 1, timedOut: false, tail: '', ...extra });
const steps = (...list) => ({ steps: list });
const withLog = (w, text) => {
  fs.mkdirSync(w.dir, { recursive: true });
  fs.writeFileSync(path.join(w.dir, '2-lint.log'), text);
  return judgeGate(steps(step('compile'), step('unitTest'), step('lint', false)), CHANGED, { dir: w.dir });
};

test('all steps green is ok, as an object, as JSON text and as a job result', () => {
  const doc = steps(step('compile'), step('unitTest'), step('lint'));
  for (const result of [doc, JSON.stringify(doc), { text: JSON.stringify(doc), costUsd: 0 }]) assert.deepEqual(judgeGate(result, CHANGED), { ok: true });
  assert.deepEqual(judgeGate(steps(step('compile'), step('unitTest')), CHANGED), { ok: true });
});

test('a failed compile or unit test fails the gate and names the step', () => {
  for (const [doc, failedStep] of [[steps(step('compile', false, { tail: 'e: lỗi' })), 'compile'], [steps(step('compile'), step('unitTest', false)), 'unitTest']]) {
    const out = judgeGate(doc, CHANGED);
    assert.equal(out.ok, false);
    assert.equal(out.failedStep, failedStep);
    assert.match(out.reason, new RegExp(failedStep));
  }
});

test('a result that is missing, unreadable or lacks a required step never passes', () => {
  for (const result of [null, undefined, '', 'x', '{}', {}, { steps: [] }, { text: '' }, steps(step('compile')), steps(step('unitTest')), { error: 'no_result' }, { steps: 'x' }, { steps: [null] }]) {
    const out = judgeGate(result, CHANGED);
    assert.equal(out.ok, false, JSON.stringify(result));
    assert.equal(typeof out.reason, 'string');
  }
});

test('lint that names a changed file fails the gate', t => {
  const w = world(t);
  for (const line of [
    'file:///w/tree/app/src/main/java/a/Foo.kt:12:5 MagicNumber',
    '/w/tree/app/src/main/java/a/Foo.kt:12: Error: x',
    'app/src/main/java/a/Foo.kt',
    '  [MagicNumber] src/main/java/a/Foo.kt:3:1',
    'Foo.kt:12:5 - sai',
    '"/w/app/src/main/res/values/strings.xml"',
  ]) {
    const out = withLog(w, `> Task :lint\n${line}\nBUILD FAILED\n`);
    assert.deepEqual([out.ok, out.failedStep], [false, 'lint'], line);
  }
});

test('lint that only names other files passes with a note', t => {
  const w = world(t);
  for (const line of ['/w/app/src/main/java/a/Bar.kt:1:1 x', '/w/app/src/main/java/a/MyFoo.kt:1', '/w/app/src/main/java/b/Foo.kt:9', 'app/src/main/java/a/Foo.kts:1', 'xem strings.xml']) {
    const out = withLog(w, `${line}\n`);
    assert.equal(out.ok, true, line);
    assert.equal(out.failedStep, undefined);
    assert.match(out.note, /lint/);
  }
});

test('a lint that timed out, has no log or a log cut at the limit cannot be excused', t => {
  const w = world(t);
  assert.equal(judgeGate(steps(step('compile'), step('unitTest'), step('lint', false)), CHANGED, { dir: w.dir }).ok, false);
  assert.equal(judgeGate(steps(step('compile'), step('unitTest'), step('lint', false)), CHANGED).ok, false);
  withLog(w, 'sạch\n');
  for (const extra of [{ timedOut: true, exitCode: null }, { exitCode: null, signal: 'SIGKILL' }]) {
    assert.equal(judgeGate(steps(step('compile'), step('unitTest'), step('lint', false, extra)), CHANGED, { dir: w.dir }).ok, false);
  }
  assert.equal(withLog(w, 'x\n'.repeat(10 * 1024 * 1024)).ok, false);
});

test('a real run of the prepared spec is judged from its stream, result file and lint log', t => {
  const w = world(t);
  const { spawnSync } = require('node:child_process');
  const script = (text, code) => [process.execPath, '-e', `console.log(${JSON.stringify(text)}); process.exit(${code})`];
  for (const [name, ok] of [['Foo', false], ['Bar', true]]) {
    w.project.commands = { compile: script('biên dịch', 0), unitTest: script('test', 0), lint: script(`/w/app/src/main/java/a/${name}.kt:3:1 sai`, 1) };
    const { command, cwd } = w.run();
    const out = spawnSync(command.bin, [...command.args, '--session-id', 's'], { cwd, encoding: 'utf8' });
    const log = path.join(w.dzHome, 'stream.jsonl');
    fs.writeFileSync(log, out.stdout);
    for (const result of [lastResultText(log).text, fs.readFileSync(path.join(w.dir, 'result.json'), 'utf8')]) {
      assert.equal(judgeGate(result, CHANGED, { dir: w.dir }).ok, ok, `${name}: ${out.stderr}`);
    }
  }
});
