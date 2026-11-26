const { execFileSync } = require('child_process');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitSucceeds(root, args) {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

function firstLine(error) {
  const text = `${error.stderr || ''}`.trim() || error.message;
  return text.split('\n')[0];
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

module.exports = { git, gitSucceeds, firstLine, fail, print, option };
