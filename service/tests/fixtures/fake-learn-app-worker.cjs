const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const F = require('../specs-build-fixtures.cjs');
const flow = require('../specs-flow-fixtures.cjs');

const CLI = path.join(__dirname, '..', '..', 'vendor', 'learn-app', 'bin', 'learn-app-state.cjs');
const cwd = process.cwd();
const args = process.argv.slice(2);
const prompt = args.at(-1);
const logFile = path.join(cwd, '.git', 'fake-worker.jsonl');
const note = entry => fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
const done = extra => {
  process.stdout.write(`${JSON.stringify({ ...F.OK, result: 'xong', ...extra })}\n`);
  process.exit(0);
};
const state = (...argv) => execFileSync(process.execPath, [CLI, ...argv], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const worktrees = () => F.g(cwd, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length;

function build() {
  const first = !fs.existsSync(path.join(cwd, '.learn-app', 'plans', '01-path.md'));
  if (first) {
    F.put(cwd, { 'plans/01-path.md': F.PLAN('01-path') });
    F.editState(cwd, learn => {
      learn.step = 'coding';
      learn.plans = {};
    });
  }
  const out = JSON.parse(state('start-plans'));
  const tree = path.join(cwd, '.learn-app', 'wt', '01-path');
  note({ first, started: out.started.map(plan => plan.id), running: out.running, worktrees: worktrees(), parallel: process.env.LEARN_APP_PARALLEL, half: fs.existsSync(path.join(tree, 'half.txt')) });
  if (first) {
    fs.writeFileSync(path.join(tree, 'half.txt'), 'half\n');
    process.kill(process.pid, 'SIGKILL');
  }
  F.commit(tree, { 'feature.txt': 'feature\n' }, 'feature');
  const branch = F.g(tree, 'rev-parse', '--abbrev-ref', 'HEAD');
  F.g(cwd, 'worktree', 'remove', '--force', tree);
  F.g(cwd, 'merge', '-q', '--no-ff', '-m', 'learn-app: merge 01-path', branch);
  F.coded(cwd, { files: { 'merged.txt': 'x\n' } });
  return done();
}

const segment = () => JSON.parse(fs.readFileSync(path.join(cwd, '.learn-app', 'inputs', 'headless.json'), 'utf8')).segment;

if (/Review độc lập code một tính năng/.test(prompt)) done({ structured_output: F.REVIEW_OK });
else if (/Thiết bị duy nhất là/.test(prompt)) {
  note({ serial: process.env.ANDROID_SERIAL });
  F.smoked(cwd);
  done();
} else if (segment() === 'build') build();
else if (segment() === 'ask') {
  F.g(cwd, 'checkout', '-q', '-b', 'learn-app/abc1');
  flow.asked(cwd);
  done();
} else {
  flow.clarified(cwd);
  done();
}
