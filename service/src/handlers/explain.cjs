const { explainPrompt, EXPLAIN_SCHEMA } = require('../specs/prompts.cjs');
const { isolatedEnv } = require('../bugs/prompts-env.cjs');
const { checkWorkDir } = require('../bugs/prompts-data.cjs');

function prepare(job, { dzHome, project }) {
  const cwd = checkWorkDir(job.payload.repo, 'repo', { dzHome, project });
  return {
    prompt: explainPrompt(job),
    cwd,
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob'],
    allowedTools: [`Read(/${cwd}/**)`],
    disallowedTools: [`Read(/${dzHome}/secrets/**)`],
    permissionMode: 'dontAsk',
    jsonSchema: EXPLAIN_SCHEMA,
    env: isolatedEnv(dzHome),
  };
}

module.exports = { prepare };
