const { findBin } = require('./find-bin.cjs');

const SERVER = 'knowledge-hub';
const tool = name => `mcp__${SERVER}__${name}`;
const KB_TOOLS = ['search_knowledge', 'read_knowledge', 'list_knowledge'].map(tool);
const KB_DENIED = ['propose_change', 'get_change_status', 'hook_context'].map(tool);

function kbAccess(searchPath = '') {
  const command = findBin('knowledge-hub-mcp', { searchPath });
  if (!command) return { mcp: [], allowed: [], denied: KB_DENIED };
  return { mcp: [JSON.stringify({ mcpServers: { [SERVER]: { command, args: [] } } })], allowed: KB_TOOLS, denied: KB_DENIED };
}

module.exports = { kbAccess, KB_TOOLS, KB_DENIED };
