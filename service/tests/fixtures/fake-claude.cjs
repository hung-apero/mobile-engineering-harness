const fs = require('node:fs');
const { spawn } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(steps) {
  for (const step of steps) {
    if ('print' in step) process.stdout.write(`${step.print}\n`);
    else if ('sleep' in step) await sleep(step.sleep);
    else if ('exit' in step) process.exit(step.exit);
    else if ('writeEnv' in step) {
      const env = Object.fromEntries(step.keys.map(k => [k, process.env[k] ?? null]));
      fs.writeFileSync(step.writeEnv, JSON.stringify(env));
    } else if ('grandchild' in step) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(step.grandchild, String(child.pid));
    } else if ('stubbornTree' in step) {
      const inner = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const code = `process.on('SIGTERM', () => {}); const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'ignore' }); require('fs').writeFileSync(process.argv[1], String(c.pid)); setInterval(() => {}, 1000)`;
      const grand = `${step.stubbornTree}.grand`;
      const child = spawn(process.execPath, ['-e', code, grand], { stdio: 'ignore', detached: true });
      fs.writeFileSync(step.stubbornTree, String(child.pid));
    } else if ('detachedShell' in step) {
      const child = spawn('sh', ['-c', step.detachedShell], { stdio: 'ignore', detached: true });
      fs.writeFileSync(step.pidFile, String(child.pid));
    } else if ('stubbornGrandchild' in step) {
      const code = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
      fs.writeFileSync(step.stubbornGrandchild, String(child.pid));
    }
  }
}

run(JSON.parse(process.env.FAKE_CLAUDE_SCRIPT || '[]')).then(() => process.exit(0));
