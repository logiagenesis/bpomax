import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { mcpConfig } from './config.js';
import { httpApiClient } from './api.js';
import { createArbitronMcpServer } from './server.js';

/**
 * The MCP process (ARB-330): speaks MCP over stdio to Claude Desktop or Claude Code and
 * calls the Arbitron API with the operator's token. Nothing is written to stdout but the
 * protocol; a missing setting is said on stderr and the process stops.
 */
const config = mcpConfig(process.env);
if (!config.ok) {
  process.stderr.write(`${config.message}\n`);
  process.exit(1);
}
const server = createArbitronMcpServer(
  httpApiClient({ baseUrl: config.baseUrl, token: config.token, channelKey: config.channelKey }),
);
await server.connect(new StdioServerTransport());
