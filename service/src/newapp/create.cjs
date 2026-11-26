const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { loadProjects } = require('../projects.cjs');

const COMMANDS = {
  compile: ['./gradlew', 'compileAppDevDebugKotlin', '--no-build-cache'],
  unitTest: ['./gradlew', 'testAppDevDebugUnitTest', '--no-build-cache'],
  lint: ['./gradlew', 'lintAppDevDebug'],
  assemble: ['./gradlew', 'assembleAppDevDebug'],
  distribute: ['./gradlew', 'appDistributionUploadAppDevDebug'],
  apkGlob: 'app/build/outputs/apk/appDev/debug/*.apk',
};
const JIRA_STATUS = { waiting: ['To Do', 'Open'], inProgress: 'In Progress', resolved: 'Done', reopened: 'Reopened', done: ['Closed', 'Done'] };

function buildDocument(ctx, app, spec, harnessCommit) {
  return {
    key: app.key,
    repo: app.repo,
    base: 'main',
    checkout: path.join(ctx.dzHome, 'workspaces', app.key),
    flavor: 'appDev',
    package: app.applicationId,
    jiraStatus: JIRA_STATUS,
    people: { po: String(app.discord.po), qa: String(app.discord.qa), devOnCall: String(app.discord.devOnCall) },
    specUrl: spec.specUrl,
    figmaUrl: spec.figmaUrl,
    channel: String(app.discord.channelId),
    excludedDevices: [],
    enabled: false,
    live: false,
    localFiles: ['local.properties', 'product.properties'],
    commands: COMMANDS,
    harnessCommit,
    forbidden: ['**/billing/**'],
  };
}

function writeProject(ctx, app, spec, harnessCommit) {
  const target = path.join(ctx.projectsDir, `${app.key}.yaml`);
  if (fs.existsSync(target)) throw new Error(`project ${app.key} đã tồn tại, không ghi đè`);
  const text = YAML.stringify(buildDocument(ctx, app, spec, harnessCommit), { defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-newapp-'));
  try {
    const staged = path.join(staging, `${app.key}.yaml`);
    fs.writeFileSync(staged, text, { mode: 0o600 });
    const { projects, errors } = loadProjects(staging, { dzHome: ctx.dzHome });
    if (errors.length || !projects.has(app.key)) throw new Error(`cấu hình tạo ra không hợp lệ: ${errors[0]?.message ?? 'không đọc được'}`);
    fs.mkdirSync(ctx.projectsDir, { recursive: true });
    const partial = path.join(ctx.projectsDir, `.${app.key}.yaml.${process.pid}.tmp`);
    fs.copyFileSync(staged, partial);
    try {
      fs.linkSync(partial, target);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`project ${app.key} đã tồn tại, không ghi đè`);
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

module.exports = { writeProject };
