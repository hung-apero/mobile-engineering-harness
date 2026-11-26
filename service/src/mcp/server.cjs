const os = require('node:os');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOLS, validateCall } = require('./tools.cjs');
const { toPublic } = require('./desk-error.cjs');
const { callService } = require('./client.cjs');
const { socketPath } = require('./socket.cjs');

const toContent = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function createDzServer({ call }) {
  const server = new Server({ name: 'dz', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    let response;
    try {
      response = await call(params.name, validateCall(params.name, params.arguments));
    } catch (error) {
      response = { ok: false, error: toPublic(error) };
    }
    return response.ok ? toContent(response.result) : { ...toContent(response.error), isError: true };
  });
  return server;
}

async function main(env = process.env) {
  const file = socketPath(path.resolve(env.DZ_HOME || path.join(os.homedir(), '.dev-zone')));
  await createDzServer({ call: (tool, args) => callService(file, tool, args) }).connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('không mở được MCP server dz\n');
    process.exitCode = 1;
  });
}

module.exports = { createDzServer, main };
