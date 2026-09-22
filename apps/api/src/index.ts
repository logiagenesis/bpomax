/**
 * Arbitron API — Fastify server and MCP server.
 *
 * Routes arrive ticket by ticket (see docs/04-PROJECT-BOARD.md):
 *   ARB-014  the audit log viewer      (routes/events.ts)
 *   ARB-021  scanner CRUD              (routes/scanners.ts)
 *   ARB-050  Telegram link codes       (routes/telegram.ts)
 *   ARB-061  who am I, dashboard, feed, approvals, settings
 *            (routes/me.ts, dashboard.ts, jobs.ts, proposals.ts, settings.ts)
 *   ARB-330  the MCP server
 */
export * from './auth.js';
export * from './server.js';

export const APP_NAME = 'arbitron-api';
