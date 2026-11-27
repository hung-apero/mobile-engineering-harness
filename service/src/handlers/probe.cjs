const path = require('node:path');

function prepare(job, { dzHome }) {
  return {
    prompt: 'Reply with exactly: OK',
    cwd: path.join(dzHome, 'probe'),
    model: 'haiku',
    tools: [],
    allowedTools: [],
    disallowedTools: [],
    mcpConfig: undefined,
  };
}

module.exports = { prepare };
