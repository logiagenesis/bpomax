import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerOptions } from './context.js';
import { registerEventRoutes } from './routes/events.js';
import { registerScannerRoutes } from './routes/scanners.js';

/**
 * The Arbitron API.
 *
 * Tenancy is not implemented here. Every read and write runs inside `withUser`, so row
 * level security decides what the caller can reach; a route that forgets a filter
 * returns less than asked for rather than more than it should. That is the whole reason
 * the policies exist, and re-implementing them in a handler would only give them
 * somewhere to drift.
 */
export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.get('/health', async () => ({ status: 'ok', service: 'arbitron-api' }));

  registerEventRoutes(app, options);
  registerScannerRoutes(app, options);

  return app;
}

export type { ServerOptions } from './context.js';
