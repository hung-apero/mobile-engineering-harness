const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkFlows } = require('./flow-rules.cjs');

const VALUE_FLAGS = ['--round', '--ts'];

function readArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--mark-pass') out.push(args[i]);
    else if (VALUE_FLAGS.includes(args[i]) && /^[\w.-]+$/.test(args[i + 1] ?? '')) out.push(args[i], args[(i += 1)]);
    else if (['--root', '--serial'].includes(args[i])) i += 1;
    else throw new Error(`tham số ${args[i]} không được phép`);
  }
  return out;
}

function main([configFile, ...args]) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const rest = readArgs(args);
  checkFlows(config);
  const script = path.join(config.harness, 'bin', 'replay.cjs');
  process.exitCode = spawnSync(process.execPath, [script, '--root', config.root, '--serial', config.serial, ...rest], { stdio: 'inherit' }).status ?? 1;
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`replay: ${error.message}\n`);
  process.exitCode = 2;
}
