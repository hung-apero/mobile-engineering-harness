#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
const { createContext } = require('../src/context.cjs');
const { runService, ExpectedError } = require('../src/run.cjs');
const { doctor } = require('../src/doctor.cjs');
const commands = require('../src/commands.cjs');
const { redact, firstLine } = require('../src/redact.cjs');
const service = require('../src/install.cjs');
const bugCommands = require('../src/bug-commands.cjs');
const specCommands = require('../src/spec-commands.cjs');
const deskCommands = require('../src/desk-commands.cjs');
const releaseCommands = require('../src/release-commands.cjs');
const newappCommands = require('../src/newapp-commands.cjs');

const USAGE = 'Cách dùng: dz run | status | probe <KEY> | retry <job> | waits [KEY] | done <waitId> | pause <KEY> | resume <KEY> | bugs on <KEY> <version> [--only KEY-1,KEY-2] [--base YYYY-MM-DD] [--fix-version A,B] | bugs off <KEY> <version> | bugs status [KEY] | bugs poll <KEY> | bugs reset-dry <KEY> <version> | batch <id> | batch park <id> | spec <link|pageId|file.md> --project KEY [--figma URL|none] | spec list [KEY] | spec show <id> | spec link <id> | spec refresh <id> | spec retry <id> [--figma URL|none] | spec build <id> --version <v> | spec prereq <id> [--pr <số|owner/repo#số>] [--branch owner/repo:nhánh] [--clear] | release status <KEY> <version> | release defer <KEY> <version> <TICKET…> --by <tên> | release e2e <KEY> <version> accept|continue --by <tên> | release done|cancel <KEY> <version> | newapp start|status|check|create <KEY> [cờ…] | desk start|stop|status|setup | web | doctor | install [--shared-login] [--allow-protected] | uninstall';
const INSTALL_FLAGS = ['--shared-login', '--allow-protected'];
const KEY = /^[A-Z][A-Z0-9]+$/;
const ARGUMENT = { install: null, uninstall: null, run: null, status: null, doctor: null, probe: KEY, pause: KEY, resume: KEY, retry: /^[1-9]\d{0,14}$/, done: /^[1-9]\d{0,14}$/, waits: null, bugs: null, batch: null, spec: null, web: null, desk: null, release: null, newapp: null };

const printLink = lines => process.stdout.write(lines.map(line => `${line}\n`).join(''));
const print = lines => process.stdout.write(lines.map(line => `${redact(line)}\n`).join(''));

function valid(name, args) {
  if (!Object.hasOwn(ARGUMENT, name)) return false;
  if (name === 'bugs') return bugCommands.validBugs(args);
  if (name === 'batch') return bugCommands.validBatch(args);
  if (name === 'spec') return specCommands.validSpec(args);
  if (name === 'desk') return deskCommands.validDesk(args);
  if (name === 'release') return releaseCommands.validRelease(args);
  if (name === 'newapp') return newappCommands.validNewapp(args);
  if (name === 'waits') return args.length === 0 || (args.length === 1 && KEY.test(args[0]));
  if (name === 'install') return args.every(arg => INSTALL_FLAGS.includes(arg)) && new Set(args).size === args.length;
  const pattern = ARGUMENT[name];
  return pattern ? args.length === 1 && pattern.test(args[0]) : args.length === 0;
}

function runDoctor() {
  const checks = doctor();
  print(checks.map(c => `${c.level} ${c.name}: ${c.detail}`));
  return checks.some(c => c.level === 'THIẾU') ? 1 : 0;
}

async function main([name = '', ...args]) {
  if (!valid(name, args)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (name === 'doctor') return runDoctor();
  if (name === 'install' || name === 'uninstall') {
    print(service[name]({ shared: args.includes('--shared-login'), allowProtected: args.includes('--allow-protected') }));
    return 0;
  }
  const ctx = createContext();
  if (name === 'run') process.exit(await runService(ctx));
  try {
    if (name === 'bugs') print(await bugCommands.bugs(ctx, args, Date.now()));
    else if (name === 'spec' && args[0] === 'link') printLink(await specCommands.spec(ctx, args, Date.now()));
    else if (name === 'spec') print(await specCommands.spec(ctx, args, Date.now()));
    else if (name === 'desk') print(await deskCommands.desk(ctx, args, Date.now()));
    else if (name === 'release') print(await releaseCommands.release(ctx, args, Date.now()));
    else if (name === 'newapp') print(await newappCommands.newapp(ctx, args, Date.now()));
    else if (name === 'web') printLink(specCommands.web(ctx));
    else if (name === 'batch') print(bugCommands.batch(ctx, args, Date.now()));
    else print(commands[name](ctx, args[0], Date.now()));
  } finally {
    await ctx.bugs.closeAll();
    await ctx.specs.closeAll();
    ctx.db.close();
  }
  return 0;
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    const expected = error instanceof ExpectedError;
    process.stderr.write(`Lỗi: ${expected ? redact(error.message) : firstLine(error)}\n`);
    process.exit(1);
  },
);
