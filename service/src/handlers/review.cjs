const { reviewPrompt, reviewResumePrompt } = require('../bugs/prompts-review.cjs');
const { isolatedEnv } = require('../bugs/prompts-env.cjs');
const { checkWorkDir } = require('../bugs/prompts-data.cjs');
const { REVIEW_SCHEMA } = require('../bugs/result.cjs');

const GIT_READS = ['log', 'show', 'diff', 'blame'];
const GIT_CONFIG = [['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['core.pager', 'cat']];

function prepare(job, { dzHome, project }) {
  return {
    prompt: reviewPrompt(job, project),
    resumePrompt: reviewResumePrompt(job, project),
    cwd: checkWorkDir(job.payload.repo, 'repo', { dzHome, project }),
    model: 'opus',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    allowedTools: ['Read', 'Grep', 'Glob', ...GIT_READS.map(name => `Bash(git ${name}:*)`)],
    disallowedTools: ['Bash(git * --output*)', 'Bash(git * --ext-diff*)', 'Bash(git * --textconv*)', `Read(/${dzHome}/secrets/**)`],
    permissionMode: 'dontAsk',
    jsonSchema: REVIEW_SCHEMA,
    env: isolatedEnv(dzHome, { config: GIT_CONFIG }),
  };
}

module.exports = { prepare };
