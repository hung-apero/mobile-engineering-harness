const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const COMMANDS = {
  compile: ['./gradlew', 'compileAppDevDebugKotlin'],
  unitTest: ['./gradlew', 'testAppDevDebugUnitTest'],
  assemble: ['./gradlew', 'assembleAppDevDebug'],
  apkGlob: 'app/build/outputs/apk/appDev/debug/*.apk',
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-projects-'));
  const dzHome = path.join(root, 'home');
  const dir = path.join(root, 'projects');
  fs.mkdirSync(path.join(dzHome, 'workspaces'), { recursive: true });
  fs.mkdirSync(dir);
  return { root, dzHome, dir };
}

function yamlFor(key, dzHome, overrides = {}) {
  const fields = {
    key,
    repo: 'apero/learn-app',
    base: 'main',
    checkout: path.join(dzHome, 'workspaces', key),
    flavor: 'appDev',
    package: 'com.apero.learn',
    jiraStatus: { waiting: ['To Do', 'Open'], inProgress: 'In Progress', resolved: 'Done', reopened: 'Reopened', done: ['Closed', 'Done'] },
    people: { po: '"123456789012345678"', qa: '"223456789012345678"', devOnCall: '"323456789012345678"' },
    specUrl: 'https://example.com/spec',
    figmaUrl: 'https://figma.com/file/x',
    excludedDevices: ['emulator-5554'],
    enabled: true,
    live: false,
    localFiles: ['local.properties'],
    commands: COMMANDS,
    harnessCommit: 'b4f5855',
    forbidden: ['**/billing/**'],
    ...overrides,
  };
  const table = (name, value, fmt) => [`${name}:`, ...Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `  ${k}: ${fmt(v)}`)];
  const lines = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (name === 'jiraStatus' || name === 'commands') lines.push(...table(name, value, JSON.stringify));
    else if (name === 'people') lines.push(...table(name, value, v => v));
    else lines.push(`${name}: ${JSON.stringify(value)}`);
  }
  return lines.join('\n') + '\n';
}

function write(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text);
}

module.exports = { setup, yamlFor, write, COMMANDS };
