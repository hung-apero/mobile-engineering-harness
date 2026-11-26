const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const server = new Server({ name: 'fake-jira', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'jira_env', description: 'env echo', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ ENABLED_TOOLS: process.env.ENABLED_TOOLS, READ_ONLY_MODE: process.env.READ_ONLY_MODE, EXTRA: process.env.EXTRA }) }],
}));
server.connect(new StdioServerTransport());
