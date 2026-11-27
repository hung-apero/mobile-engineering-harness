const { execFileSync } = require('node:child_process');

const OPTIONS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
const git = (...args) => execFileSync('git', [...OPTIONS, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

function problemOf(sha) {
  const head = git('rev-parse', 'HEAD');
  if (head !== sha) return `HEAD là ${head}, cần ${sha}`;
  const dirty = git('status', '--porcelain', '--untracked-files=no');
  return dirty ? `file được git theo dõi đã đổi:\n${dirty.slice(0, 2000)}` : null;
}

const problem = problemOf(process.argv[2]);
if (problem) {
  process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
}
