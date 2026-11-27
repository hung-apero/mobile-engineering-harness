const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { contain } = require('../src/sandbox.cjs');
const { applyEnv, workerEnv } = require('../src/worker-env.cjs');
const { makeHome } = require('./service-fixtures.cjs');

const ON_MAC = { skip: process.platform !== 'darwin' && 'cần macOS' };

function world(t, { port = '18787' } = {}) {
  const h = makeHome(t);
  h.env.DZ_WEB_PORT = port;
  const ctx = h.context();
  const root = path.join(h.dzHome, 'workspaces', 'ABC1');
  const repo = path.join(root, 'batches', '1', 'repo');
  const project = { key: 'ABC1', live: true };
  for (const dir of [repo, path.join(root, 'batches', '2', 'repo'), path.join(h.dzHome, 'desk'), path.join(h.dzHome, 'app')]) fs.mkdirSync(dir, { recursive: true });
  const at = (...parts) => path.join(h.dzHome, ...parts);
  for (const file of ['secrets/t', 'service.lock', 'desk/x', 'logs/l', 'dz.db-extra']) fs.writeFileSync(at(file), 'BIMAT');

  function box(job = {}, prepared = {}) {
    const env = applyEnv(workerEnv(ctx.env, ctx.dzHome), prepared.env);
    return contain(ctx, { id: 1, kind: 'bug', ...job }, project, { cwd: repo, ...prepared }, env);
  }
  function run(contained, argv, options = {}) {
    const out = spawnSync(contained.sandbox.bin, ['-f', contained.sandbox.profile, ...argv], { encoding: 'utf8', env: contained.env, cwd: repo, ...options });
    return { code: out.status, out: out.stdout, err: out.stderr };
  }
  const sh = (contained, script) => run(contained, ['/bin/sh', '-c', script]);
  const node = (contained, script) => new Promise(resolve => {
    const child = spawn(contained.sandbox.bin, ['-f', contained.sandbox.profile, process.execPath, '-e', script], { env: contained.env, cwd: repo });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', () => resolve(out));
  });
  return { h, ctx, root, repo, project, at, box, run, sh, node };
}

module.exports = { world, ON_MAC };
