const fs = require('node:fs');
const path = require('node:path');
const { specPrompt, PLUGIN_ROOT } = require('../specs/prompts.cjs');
const { figmaReadConfig, FIGMA_TOOLS } = require('../specs/figma-config.cjs');
const { featureReviewPrompt, FEATURE_REVIEW_SCHEMA } = require('../specs/feature-review.cjs');
const { writeAdbWrapper, SERIAL } = require('../devices.cjs');
const { isolatedEnv, IDENTITY, NO_PUSH } = require('../bugs/prompts-env.cjs');
const { checkWorkDir, bad } = require('../bugs/prompts-data.cjs');
const { DENIED_COMMANDS, DENIED_TOOLS } = require('./bug.cjs');

const ALLOWED = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Skill', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'Monitor'];
const COMMANDS = [...DENIED_COMMANDS.filter(command => !command.startsWith('git push')), 'git push', 'xdg-open'];
const EMULATOR = ['emulator', 'avdmanager', 'sdkmanager'];
const OTHER_ADB = ['Bash(*platform-tools/adb*)', 'Bash(*emulator/emulator*)', 'Bash(*bin/avdmanager*)'];
const GIT_READS = ['log', 'show', 'diff', 'blame'];
const READ_ONLY_GIT = [['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['core.pager', 'cat']];

function checkLock(dzHome, { serial, holder, specId }) {
  let locks = {};
  try {
    locks = JSON.parse(fs.readFileSync(path.join(dzHome, 'bug-fix-state', 'devices.json'), 'utf8'));
  } catch {}
  if (holder !== `spec:${specId}:run` || locks[serial]?.holder !== holder) throw new Error(`việc chạy thử không còn giữ khoá thiết bị ${serial}`);
}

function deviceEnv({ payload }, { dzHome, project, adb, deps }) {
  if (payload.segment !== 'smoke') return {};
  const { serial } = payload;
  if (typeof serial !== 'string' || !SERIAL.test(serial) || (project.excludedDevices ?? []).includes(serial)) bad('serial');
  (deps?.checkLock ?? checkLock)(dzHome, payload);
  const wrapper = writeAdbWrapper({ dzHome, serial, adb });
  return { ANDROID_SERIAL: serial, PATH: `${wrapper}${path.delimiter}${process.env.PATH}` };
}

function prepareReview(job, { dzHome, project }) {
  return {
    prompt: featureReviewPrompt(job.payload, { dzHome, project }),
    resumePrompt: 'Review bị dừng giữa chừng. Làm tiếp, vẫn chỉ đọc, rồi trả kết quả theo schema.',
    cwd: checkWorkDir(job.payload.repo, 'repo', { dzHome, project }),
    model: 'opus',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    allowedTools: ['Read', 'Grep', 'Glob', ...GIT_READS.map(name => `Bash(git ${name}:*)`)],
    disallowedTools: ['Bash(git * --output*)', 'Bash(git * --ext-diff*)', 'Bash(git * --textconv*)', `Read(/${dzHome}/secrets/**)`],
    permissionMode: 'dontAsk',
    jsonSchema: FEATURE_REVIEW_SCHEMA,
    env: isolatedEnv(dzHome, { config: READ_ONLY_GIT }),
  };
}

function prepare(job, options) {
  const { dzHome, project } = options;
  const { payload } = job;
  if (payload.type === 'review') return prepareReview(job, options);
  const prompt = specPrompt(job);
  const smoke = payload.segment === 'smoke';
  const building = smoke || payload.segment === 'build';
  const denied = building ? [...COMMANDS.filter(command => !(smoke && command === 'adb')), ...EMULATOR] : COMMANDS;
  return {
    prompt,
    resumePrompt: prompt,
    cwd: checkWorkDir(payload.repo, 'repo', { dzHome, project }),
    model: 'sonnet',
    allowedTools: [...ALLOWED, ...(payload.figma ? FIGMA_TOOLS : [])],
    disallowedTools: ['AskUserQuestion', ...denied.map(command => `Bash(${command}:*)`), ...(building ? OTHER_ADB : []), ...DENIED_TOOLS, `Read(/${dzHome}/secrets/**)`],
    mcpConfig: payload.figma ? figmaReadConfig(dzHome) : undefined,
    pluginDirs: [PLUGIN_ROOT],
    env: {
      ...isolatedEnv(dzHome, { config: NO_PUSH }),
      ...IDENTITY,
      LEARN_APP_HEADLESS: '1',
      LEARN_APP_TRACKING: project.live === true ? null : 'off',
      ...(building && { LEARN_APP_PARALLEL: String(Math.max(1, job.slotsGranted ?? 1)) }),
      ...deviceEnv(job, options),
    },
  };
}

module.exports = { prepare, checkLock };
