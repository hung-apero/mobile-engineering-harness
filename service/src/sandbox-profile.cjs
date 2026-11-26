const fs = require('node:fs');
const path = require('node:path');

const HOME_SECRETS = ['.ssh', '.config/gh', '.netrc', '.git-credentials', '.aws'];
const HOME_STARTUP = [
  '.zshenv', '.zprofile', '.zshrc', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.gitconfig', '.config/git',
  'Library/LaunchAgents', '.local/bin', '.local/share/claude',
];
const GRADLE_STARTUP = ['init.d', 'init.gradle', 'init.gradle.kts', 'gradle.properties'];
const BREW = ['bin', 'Cellar', 'opt', 'lib', 'etc'].map(name => `/opt/homebrew/${name}`);
const CLAUDE_STARTUP = ['settings.json', 'settings.local.json', 'CLAUDE.md', 'plugins', 'skills', 'commands', 'agents', 'hooks', 'rules'];
const SERVICE_PRIVATE = ['secrets', 'desk', 'logs', 'runs'];
const KEYCHAIN = ['com.apple.SecurityServer', 'com.apple.securityd', 'com.apple.securityd.xpc', 'com.apple.securityd.general', 'com.apple.secd'];
const OUTSIDE_SOCKETS = ['^/private/tmp/tmux-', '^/private/tmp/com[.]apple[.]launchd[.]', '^/private/var/run/com[.]apple[.]launchd[.]'];

const within = (target, root) => target === root || target.startsWith(root + path.sep);
const unique = list => [...new Set(list)];
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function real(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(real(parent), path.basename(target));
  }
}

function quote(text, prefix = '') {
  if (/["\\\p{Cc}]/u.test(prefix ? text.replaceAll('\\', '') : text)) throw new Error('đường dẫn có ký tự không dùng được trong sandbox');
  return `${prefix}"${text}"`;
}

function rule(head, kind, values) {
  const filters = unique(values).map(value => `  (${kind} ${quote(value, kind === 'regex' ? '#' : '')})`);
  return filters.length ? [`(${head}`, ...filters, ')'].join('\n') : '';
}

function ancestors(targets) {
  const found = [];
  for (const target of targets) {
    for (let dir = path.dirname(target); dir !== path.dirname(dir); dir = path.dirname(dir)) found.push(dir);
  }
  return found;
}

function toolDirs({ searchPath, bins, home, dzHome }) {
  const dirs = [...searchPath.split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(real), ...bins.map(bin => path.dirname(real(bin)))];
  return dirs.filter(dir => !within(home, dir) && !within(dzHome, dir));
}

function networkRules(ports, dzHome) {
  const sockets = [...OUTSIDE_SOCKETS, `^${escapeRegex(dzHome)}/`].map(pattern => `  (remote unix-socket (path-regex ${quote(pattern, '#')}))`);
  return [
    ['(deny network-outbound', ...sockets, ')'].join('\n'),
    ...ports.map(port => `(deny network-outbound (remote ip "*:${port}"))\n(deny network-bind (local ip "*:${port}"))`),
  ];
}

function profileText({ home, dzHome, runDir, mcpConfig, codeRoot, claudeDir, gradleDir, shared, agent, writes, mirror, ports, searchPath, bins }) {
  const at = (root, names) => names.map(name => path.join(root, name));
  const closed = agent ? [...(shared ? [] : at(home, ['.claude', '.claude.json']))] : [claudeDir, ...at(home, ['.claude', '.claude.json', 'Library/Keychains'])];
  const hidden = [...at(home, HOME_SECRETS), path.join(gradleDir, 'daemon'), path.join(home, 'Library/Application Support/kotlin/daemon'), ...closed];
  const startup = [...at(home, HOME_STARTUP), ...at(gradleDir, GRADLE_STARTUP), ...at(claudeDir, CLAUDE_STARTUP)];
  const deskNotes = path.join(claudeDir, 'projects', path.join(dzHome, 'desk').replace(/[^A-Za-z0-9]/g, '-'));
  const gitLinks = writes.map(dir => path.join(dir, '.git')).filter(file => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile());
  return [
    '(version 1)',
    '(allow default)',
    '(allow process-exec (literal "/bin/ps") (with no-sandbox))',
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny appleevent-send)',
    '(deny job-creation)',
    '(deny lsopen)',
    rule('deny file-write*', 'subpath', [dzHome]),
    rule('allow file-write*', 'subpath', [path.join(dzHome, 'bug-fix-state'), ...(agent ? [claudeDir] : []), ...writes]),
    mirror ? rule('allow file-write*', 'subpath', at(mirror, ['objects', 'refs/heads/fix'])) : '',
    mirror ? rule('deny file-write*', 'subpath', at(mirror, ['objects/info'])) : '',
    rule('deny file-write*', 'subpath', [...startup, ...BREW, ...toolDirs({ searchPath, bins, home, dzHome }), codeRoot, ...gitLinks]),
    rule('deny file-read* file-write*', 'subpath', [...hidden, ...at(dzHome, SERVICE_PRIVATE), deskNotes]),
    rule('deny file-read* file-write*', 'regex', [`^${escapeRegex(dzHome)}/(dz[.]db|service[.]lock|[^/]*[.]sock$)`]),
    rule('deny file-write-unlink', 'literal', ancestors([dzHome, ...hidden, ...startup])),
    rule('allow file-read-metadata', 'literal', [path.join(dzHome, 'runs'), runDir]),
    rule('allow file-read* file-write*', 'subpath', [path.join(runDir, 'work')]),
    mcpConfig ? rule('allow file-read*', 'literal', [mcpConfig]) : '',
    agent ? '' : rule('deny mach-lookup', 'global-name', KEYCHAIN),
    ...networkRules(ports, dzHome),
    '',
  ].filter((line, index, all) => line || index === all.length - 1).join('\n');
}

module.exports = { profileText, real, within };
