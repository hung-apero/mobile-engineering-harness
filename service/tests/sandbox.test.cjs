const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { pruneRuns } = require('../src/sandbox.cjs');
const jobs = require('../src/jobs.cjs');
const { add, NOW } = require('./service-fixtures.cjs');
const { world, ON_MAC } = require('./sandbox-fixtures.cjs');

const listen = (server, ...args) => new Promise(resolve => server.listen(...args, () => resolve(server)));

test('a worker reads none of the service secrets, by name, other case, link, copy or rename', ON_MAC, t => {
  const w = world(t);
  const c = w.box();
  for (const file of ['secrets/t', 'dz.db', 'dz.db-extra', 'service.lock', 'desk/x', 'logs/l', 'DZ.DB']) {
    const out = w.sh(c, `cat "${w.at(file)}"; cat "/System/Volumes/Data${w.at(file)}"; ln "${w.at(file)}" hl; cp -c "${w.at(file)}" cl; cat hl cl`);
    assert.equal(out.out, '', file);
  }
  for (const [from, to] of [[w.at('secrets'), 's'], [w.h.dzHome, path.join(w.h.root, 'moved')], [w.h.root, `${w.h.root}-moved`]]) {
    assert.notEqual(w.sh(c, `mv "${from}" "${to}"`).code, 0, from);
  }
  assert.equal(fs.readFileSync(w.at('secrets/t'), 'utf8'), 'BIMAT');
});

test('a worker writes only in its own folders', ON_MAC, t => {
  const w = world(t);
  const c = w.box();
  const work = path.join(path.dirname(c.sandbox.profile), 'work');
  for (const file of ['secrets/new', 'dz.db', 'service.lock', 'desk/new', 'logs/new', 'projects/ABC1.yaml', 'app/new', 'new', 'workspaces/ABC1/batches/2/repo/new', 'workspaces/ABC1/batches/1/start-sha', 'workspaces/ABC1/batches/1/gate-1/spec.json']) {
    assert.notEqual(w.sh(c, `mkdir -p "$(dirname "${w.at(file)}")"; echo x > "${w.at(file)}"`).code, 0, file);
  }
  for (const file of [c.sandbox.profile, path.join(os.homedir(), '.gitconfig.lock', 'x'), path.join(path.dirname(process.execPath), 'dz-test')]) assert.notEqual(w.sh(c, `touch "${file}"`).code, 0, file);
  for (const dir of [w.repo, `${w.repo}-worktrees/a`, work, w.at('bug-fix-state'), w.at('claude'), os.tmpdir()]) {
    const name = path.join(dir, `dz-ok-${process.pid}`);
    assert.equal(w.sh(c, `mkdir -p "${dir}" && echo x > "${name}" && rm "${name}"`).code, 0, dir);
  }
  for (const name of ['settings.json', 'plugins']) assert.notEqual(w.sh(c, `touch "${w.at('claude', name)}"`).code, 0, name);
});

test('normal tools work: node, ps, git, killing its own child', ON_MAC, t => {
  const w = world(t);
  const c = w.box();
  assert.equal(w.run(c, [process.execPath, '-e', 'require("fs").writeFileSync("a.txt", "x"); console.log(require("fs").readFileSync("a.txt", "utf8"))']).out, 'x\n');
  assert.match(w.sh(c, 'ps -o pid= -p $$').out, /^\s*\d+\s*$/);
  assert.equal(w.sh(c, 'sleep 30 & kill $!').code, 0);
  assert.equal(w.sh(c, `cat "${w.at('projects/ABC1.yaml')}" > /dev/null`).code, 0);
});

test('a worker cannot read home credentials or leave the sandbox through launchd, open or Apple events', ON_MAC, t => {
  const w = world(t);
  const c = w.box();
  for (const dir of ['.ssh', '.config/gh', '.gradle/daemon', '.claude']) {
    if (fs.existsSync(path.join(os.homedir(), dir))) assert.notEqual(w.sh(c, `ls "${path.join(os.homedir(), dir)}"`).code, 0, dir);
  }
  const mark = path.join(w.h.root, 'escaped');
  assert.notEqual(w.sh(c, `launchctl submit -l dz.test.${process.pid} -- /usr/bin/touch "${mark}"`).code, 0);
  assert.notEqual(w.sh(c, 'open -g -a TextEdit').code, 0);
  assert.notEqual(w.sh(c, `osascript -e 'tell application "Finder" to count windows'`).code, 0);
  assert.equal(fs.existsSync(mark), false);
});

test('a worker cannot reach or take the web port, the desk socket or another process', ON_MAC, async t => {
  const probe = await listen(http.createServer(), 0);
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const w = world(t, { port: String(port) });
  const web = await listen(http.createServer((req, res) => res.end('hit')), port, '0.0.0.0');
  const desk = await listen(net.createServer(s => s.end('hit')), w.at('desk.sock'));
  const other = await listen(http.createServer((req, res) => res.end('hit')), 0, '127.0.0.1');
  const outside = spawn('/bin/sleep', ['60']);
  t.after(() => { for (const s of [web, desk, other]) s.close(); outside.kill(); });
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
  const out = await w.node(w.box(), `
    const net = require('net');
    const tryTo = (name, options) => new Promise(r => { const s = net.connect(options).on('connect', () => { console.log(name, 'open'); s.destroy(); r(); }).on('error', e => { console.log(name, e.code); r(); }); });
    (async () => {
      for (const host of ['127.0.0.1', 'localhost', '::ffff:127.0.0.1', '${lan}']) await tryTo('web', { host, port: ${port} });
      await tryTo('desk', { path: ${JSON.stringify(w.at('desk.sock'))} });
      await tryTo('other', { host: '127.0.0.1', port: ${other.address().port} });
      try { process.kill(${outside.pid}, 'SIGUSR1'); console.log('signal sent'); } catch (e) { console.log('signal', e.code); }
    })();`);
  assert.deepEqual(out.trim().split('\n'), [...Array(4).fill('web EPERM'), 'desk EPERM', 'other open', 'signal EPERM']);
  await new Promise(resolve => web.close(resolve));
  assert.match(await w.node(w.box(), `require('net').createServer().on('error', e => console.log(e.code)).listen(${port}, '127.0.0.1', () => { console.log('bound'); process.exit(); })`), /EPERM/);
});

test('a bug worker pushes a fix branch to the local mirror and cannot touch its other parts', ON_MAC, t => {
  const w = world(t);
  const mirror = path.join(w.root, 'mirror.git');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(w.root, 'init', '-q', '--bare', '--template=', mirror);
  fs.mkdirSync(path.join(mirror, 'hooks'));
  fs.writeFileSync(path.join(mirror, 'hooks', 'update'), '#!/bin/sh\ncase "$1" in refs/heads/fix/*) exit 0;; esac\nexit 1\n', { mode: 0o755 });
  const seed = path.join(w.h.root, 'seed');
  git(w.h.root, 'init', '-q', '-b', 'main', seed);
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(mirror, 'fetch', '-q', seed, 'main:refs/heads/main');
  fs.rmSync(w.repo, { recursive: true });
  git(w.root, 'clone', '-q', '-b', 'main', mirror, w.repo);
  const c = w.box();
  const out = w.sh(c, 'git config user.name a && git config user.email a@b && git worktree add -q -b fix/x ../repo-worktrees/x origin/main && cd ../repo-worktrees/x && echo b > b && git add b && git commit -q -m b && git push -q origin fix/x && echo c > b && git commit -q -am c && git push -q origin fix/x');
  assert.equal(out.code, 0, out.err);
  assert.match(git(mirror, 'log', '--format=%s', 'fix/x'), /^c\nb\na/);
  for (const script of ['git push -q origin fix/x:main', `git --git-dir="${mirror}" update-ref refs/heads/main fix/x`, `echo x > "${mirror}/hooks/update"`, `echo x >> "${mirror}/config"`, `echo x > "${mirror}/refs/heads/main"`]) {
    assert.notEqual(w.sh(c, script).code, 0, script);
  }
  const spec = w.box({ id: 2, kind: 'spec' });
  assert.notEqual(w.sh(spec, 'git push -q origin HEAD:refs/heads/fix/y').code, 0);
});

test('the mcp config is a private copy that only its own job can read and that goes away with the job', ON_MAC, t => {
  const w = world(t);
  const source = w.at('secrets', 'jira-read.json');
  fs.writeFileSync(source, '{"token":1}', { mode: 0o600 });
  const [a, b] = ['x', 'y'].map(key => add(w.ctx, 'ABC1', key));
  jobs.claimNext(w.ctx.db, { projects: new Set(['ABC1']), limits: { code_agents_working: 3, code_agents_off: 3, reserved_for_bug: 0, build: 1, bugs_per_project: 2 }, now: NOW });
  const mine = w.box({ id: a }, { mcpConfig: source });
  const theirs = w.box({ id: b }, { mcpConfig: source });
  assert.equal(fs.statSync(mine.mcpConfig).mode & 0o777, 0o600);
  assert.equal(w.sh(mine, `cat "${mine.mcpConfig}"`).out, '{"token":1}');
  assert.equal(w.sh(mine, `cat "${theirs.mcpConfig}"`).out, '');
  assert.notEqual(w.sh(mine, `ls "${w.at('runs')}"`).code, 0);
  assert.equal(jobs.getJob(w.ctx.db, a).state, 'starting');
  pruneRuns(w.ctx);
  assert.ok(fs.existsSync(mine.mcpConfig));
  assert.ok(!fs.existsSync(theirs.mcpConfig));
  jobs.park(w.ctx.db, a, 'x', NOW);
  pruneRuns(w.ctx);
  assert.deepEqual(fs.readdirSync(w.at('runs')), []);
  const open = w.box({}, { mcpConfig: '/tmp/maestro-mcp.json' });
  assert.equal(open.mcpConfig, '/tmp/maestro-mcp.json');
});
