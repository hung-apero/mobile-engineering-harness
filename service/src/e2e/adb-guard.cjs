const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { judgeAdb } = require('./adb-rules.cjs');

const refuse = reason => {
  process.stderr.write(`adb: ${reason}\n`);
  process.exitCode = 2;
};

function listDevices(config, args) {
  const out = spawnSync(config.adb, args, { encoding: 'utf8', timeout: 30000 });
  const [head = 'List of devices attached', ...rows] = String(out.stdout ?? '').split(/\r?\n/);
  process.stdout.write(`${[head, ...rows.filter(row => row.split(/\s/)[0] === config.serial)].join('\n')}\n`);
  process.exitCode = out.status ?? 1;
}

function note(config, entry, out) {
  const failed = out.status !== 0 || /\bFailure\b/.test(`${out.stdout ?? ''}${out.stderr ?? ''}`);
  fs.appendFileSync(config.journal, `${JSON.stringify({ ...entry, ok: !failed, at: Date.now() })}\n`, { mode: 0o600 });
}

function main([configFile, ...args]) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const rule = judgeAdb(args, config);
  if (!rule.ok) return refuse(rule.reason);
  if (rule.devices) return listDevices(config, args);
  if (!rule.journal) {
    process.exitCode = spawnSync(config.adb, args, { stdio: 'inherit' }).status ?? 1;
    return undefined;
  }
  const out = spawnSync(config.adb, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  note(config, rule.journal, out);
  process.stdout.write(out.stdout ?? '');
  process.stderr.write(out.stderr ?? '');
  process.exitCode = out.status ?? 1;
  return undefined;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch {
    refuse('không đọc được cấu hình, từ chối');
  }
}
