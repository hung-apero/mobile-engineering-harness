const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { install, uninstall, LABEL } = require('../src/install.cjs');

const BIN = {
  node: '/opt/homebrew/bin/node',
  claude: '/Users/tester/.local/bin/claude',
  adb: '/Users/tester/Library/Android/sdk/platform-tools/adb',
  gh: '/opt/homebrew/bin/gh',
  uvx: '/opt/homebrew/bin/uvx',
  git: '/usr/bin/git',
};

function setup(t, env = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-install-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const outDir = path.join(root, 'LaunchAgents');
  fs.mkdirSync(home);
  const opts = {
    home,
    outDir,
    env: { JAVA_HOME: '/jdk/home', ANDROID_HOME: '/sdk', LANG: 'en_US.UTF-8', ...env },
    which: name => BIN[name] ?? null,
    uid: 501,
    node: BIN.node,
  };
  return { root, home, outDir, opts, plist: path.join(outDir, `${LABEL}.plist`) };
}

const dzBin = path.resolve(__dirname, '..', 'bin', 'dz.cjs');

test('generated plist passes plutil -lint', t => {
  const s = setup(t);
  install(s.opts);
  const out = spawnSync('plutil', ['-lint', s.plist], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

test('plist runs caffeinate with absolute node and dz.cjs, keeps alive, throttles 30', t => {
  const s = setup(t);
  install(s.opts);
  const text = fs.readFileSync(s.plist, 'utf8');
  const args = [...text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
  assert.deepEqual(args, ['/usr/bin/caffeinate', '-i', BIN.node, dzBin, 'run']);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(text, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(text, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
});

test('$HOME is replaced: no placeholder left, DZ_HOME and logs live under the given home', t => {
  const s = setup(t);
  install(s.opts);
  const text = fs.readFileSync(s.plist, 'utf8');
  assert.doesNotMatch(text, /\$HOME|\{\{|~\//);
  const dzHome = path.join(s.home, '.dev-zone');
  assert.match(text, new RegExp(`<key>DZ_HOME</key>\\s*<string>${dzHome}</string>`));
  assert.ok(text.includes(`<string>${dzHome}/logs/launchd.out.log</string>`));
  assert.ok(text.includes(`<string>${dzHome}/logs/launchd.err.log</string>`));
});

test('plist carries PATH of tool dirs, JAVA_HOME, ANDROID_HOME, LANG and nothing secret', t => {
  const s = setup(t, {
    DZ_DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1/hunter2',
    DISCORD_TOKEN: 'tok-secret',
    GITHUB_TOKEN: 'ghp_secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
  });
  install(s.opts);
  const text = fs.readFileSync(s.plist, 'utf8');
  const value = key => text.match(new RegExp(`<key>${key}</key>\\s*<string>(.*?)</string>`))[1];
  const pathDirs = value('PATH').split(':');
  for (const bin of Object.values(BIN)) assert.ok(pathDirs.includes(path.dirname(bin)), bin);
  assert.equal(new Set(pathDirs).size, pathDirs.length);
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) assert.ok(pathDirs.includes(dir));
  assert.equal(value('JAVA_HOME'), '/jdk/home');
  assert.equal(value('ANDROID_HOME'), '/sdk');
  assert.equal(value('LANG'), 'en_US.UTF-8');
  for (const secret of ['hunter2', 'tok-secret', 'ghp_secret', 'sk-ant-secret', 'DISCORD', 'TOKEN', 'API_KEY']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.doesNotMatch(text, /DZ_CLAUDE_CONFIG/);
});

test('--shared-login adds DZ_CLAUDE_CONFIG=shared', t => {
  const s = setup(t);
  install({ ...s.opts, shared: true });
  assert.match(fs.readFileSync(s.plist, 'utf8'), /<key>DZ_CLAUDE_CONFIG<\/key>\s*<string>shared<\/string>/);
});

test('unknown JAVA_HOME and ANDROID_HOME are left out', t => {
  const s = setup(t, { JAVA_HOME: undefined, ANDROID_HOME: undefined, ANDROID_SDK_ROOT: undefined });
  install(s.opts);
  assert.doesNotMatch(fs.readFileSync(s.plist, 'utf8'), /JAVA_HOME|ANDROID_HOME/);
});

test('values are XML-escaped', t => {
  const s = setup(t, { JAVA_HOME: '/a&b/<c>"d"' });
  install(s.opts);
  const text = fs.readFileSync(s.plist, 'utf8');
  assert.ok(text.includes('/a&amp;b/&lt;c&gt;&quot;d&quot;'));
  assert.equal(spawnSync('plutil', ['-lint', s.plist]).status, 0);
});

test('plist is mode 600 and install prints the launchctl commands without running them', t => {
  const s = setup(t);
  const lines = install(s.opts);
  assert.equal(fs.statSync(s.plist).mode & 0o777, 0o600);
  const bootout = lines.indexOf('launchctl bootout gui/501/com.devzone.service');
  const bootstrap = lines.indexOf(`launchctl bootstrap gui/501 ${s.plist}`);
  assert.ok(bootout !== -1 && bootout < bootstrap);
});

test('install refuses to overwrite a plist it did not generate, and re-install overwrites its own', t => {
  const s = setup(t);
  fs.mkdirSync(s.outDir);
  fs.writeFileSync(s.plist, '<plist><dict><key>Label</key><string>mine</string></dict></plist>');
  assert.throws(() => install(s.opts), /không phải do dz tạo/);
  assert.match(fs.readFileSync(s.plist, 'utf8'), /mine/);
  fs.rmSync(s.plist);
  install(s.opts);
  install({ ...s.opts, shared: true });
  assert.match(fs.readFileSync(s.plist, 'utf8'), /shared/);
});

test('install fails when claude or git cannot be found', t => {
  const s = setup(t);
  assert.throws(() => install({ ...s.opts, which: name => (name === 'claude' ? null : BIN[name]) }), /claude/);
  assert.equal(fs.existsSync(s.plist), false);
});

test('uninstall removes only its own plist, nothing else in the folder or DZ_HOME', t => {
  const s = setup(t);
  install(s.opts);
  const other = path.join(s.outDir, 'com.other.plist');
  fs.writeFileSync(other, 'x');
  const dzHome = path.join(s.home, '.dev-zone');
  const lines = uninstall(s.opts);
  assert.equal(fs.existsSync(s.plist), false);
  assert.equal(fs.existsSync(other), true);
  assert.equal(fs.existsSync(dzHome), true);
  assert.ok(lines.some(l => l.includes('launchctl bootout gui/501/com.devzone.service')));
});

test('uninstall leaves a foreign plist alone and says so; a missing plist is not an error', t => {
  const s = setup(t);
  fs.mkdirSync(s.outDir);
  fs.writeFileSync(s.plist, 'foreign');
  assert.throws(() => uninstall(s.opts), /không phải do dz tạo/);
  assert.equal(fs.readFileSync(s.plist, 'utf8'), 'foreign');
  fs.rmSync(s.plist);
  assert.deepEqual(uninstall(s.opts).length > 0, true);
});

test('node is the running binary, its folder comes first on PATH, and node need not be on PATH', t => {
  const s = setup(t);
  install({ ...s.opts, node: undefined, which: name => (name === 'node' ? null : BIN[name]) });
  const text = fs.readFileSync(s.plist, 'utf8');
  assert.ok(text.includes(`<string>${process.execPath}</string>`));
  assert.match(text, new RegExp(`<key>PATH</key>\\s*<string>${path.dirname(process.execPath)}:`));
});

test('DZ_HOME is made absolute and created with logs, mode 700', t => {
  const s = setup(t, { DZ_HOME: path.relative(process.cwd(), path.join(os.tmpdir(), 'x')) });
  const relative = path.relative(process.cwd(), path.join(s.root, 'dz'));
  install({ ...s.opts, env: { ...s.opts.env, DZ_HOME: relative } });
  const dzHome = path.join(s.root, 'dz');
  const text = fs.readFileSync(s.plist, 'utf8');
  assert.ok(text.includes(`<key>DZ_HOME</key>\n    <string>${path.resolve(relative)}</string>`));
  assert.ok(text.includes(`<string>${path.resolve(relative)}/logs/launchd.err.log</string>`));
  for (const dir of [dzHome, path.join(dzHome, 'logs')]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.chmodSync(path.join(dzHome, 'logs'), 0o755);
  install({ ...s.opts, dzHome: relative, env: s.opts.env });
  assert.equal(fs.statSync(path.join(dzHome, 'logs')).mode & 0o777, 0o700);
});

test('install refuses code under Desktop, Documents or Downloads and writes nothing; --allow-protected overrides', t => {
  const s = setup(t);
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const codeDir = path.join(s.home, name, 'src', 'service');
    fs.mkdirSync(codeDir, { recursive: true });
    assert.throws(() => install({ ...s.opts, codeDir }), new RegExp(`${name}.*--allow-protected`, 's'));
    const link = path.join(s.root, `link-${name}`);
    fs.symlinkSync(codeDir, link);
    assert.throws(() => install({ ...s.opts, codeDir: link }), /--allow-protected/);
  }
  assert.equal(fs.existsSync(s.plist), false);
  assert.equal(fs.existsSync(path.join(s.home, '.dev-zone')), false);
  install({ ...s.opts, codeDir: path.join(s.home, 'Desktop', 'src', 'service'), allowProtected: true });
  assert.equal(fs.existsSync(s.plist), true);
  for (const name of ['.dev-zone/app/service', 'DesktopX/service']) {
    const codeDir = path.join(s.home, name);
    fs.mkdirSync(codeDir, { recursive: true });
    install({ ...s.opts, codeDir });
  }
});
