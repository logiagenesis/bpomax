/**
 * Arbitron API — Fastify server and MCP server.
 *
 * Routes arrive ticket by ticket (see docs/04-PROJECT-BOARD.md):
 *   ARB-014  the audit log viewer      (server.ts)
 *   ARB-330  the MCP server
 */
export * from './server.js';

export const APP_NAME = 'arbitron-api';
