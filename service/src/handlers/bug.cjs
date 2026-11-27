const { bugPrompt, bugResumePrompt } = require('../bugs/prompts-bug.cjs');
const { jiraReadConfig, JIRA_TOOLS } = require('../bugs/prompts-jira-config.cjs');
const { isolatedEnv, IDENTITY } = require('../bugs/prompts-env.cjs');
const { checkWorkDir } = require('../bugs/prompts-data.cjs');
const { kbAccess } = require('../knowledge-hub.cjs');

const ALLOWED = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Skill', 'SendMessage',
  'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'Monitor', ...JIRA_TOOLS,
];
const DENIED_COMMANDS = [
  'gh', 'adb', 'curl', 'wget', 'ssh', 'rm -rf', 'sudo', 'git push --force', 'git push -f', 'git remote',
  'security', 'scp', 'rsync', 'open', 'osascript', 'launchctl', 'npm publish',
];
const DENIED_TOOLS = ['WebFetch', 'WebSearch', 'RemoteTrigger', 'PushNotification', 'CronCreate', 'ScheduleWakeup', 'DesignSync'];

function prepare(job, { dzHome, project, searchPath }) {
  const kb = kbAccess(searchPath);
  return {
    prompt: bugPrompt(job, project),
    resumePrompt: bugResumePrompt(job, project),
    cwd: checkWorkDir(job.payload.repo, 'repo', { dzHome, project }),
    model: 'sonnet',
    allowedTools: [...ALLOWED, ...kb.allowed],
    disallowedTools: [...DENIED_COMMANDS.map(command => `Bash(${command}:*)`), ...DENIED_TOOLS, ...kb.denied, `Read(/${dzHome}/secrets/**)`],
    mcpConfig: jiraReadConfig(dzHome),
    extraMcp: kb.mcp,
    env: { ...isolatedEnv(dzHome), ...IDENTITY },
  };
}

module.exports = { prepare, DENIED_COMMANDS, DENIED_TOOLS };
