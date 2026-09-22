import cors from '@fastify/cors';
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

  // The browser side of tenancy: only the web app's own origin may call this API, and it
  // signs each request with a bearer token rather than a cookie, so credentials stay off.
  // The three exposed headers are what the CSV export tells the page about the file.
  void app.register(cors, {
    origin: options.webOrigin === undefined ? false : [...toList(options.webOrigin)],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: false,
    exposedHeaders: ['content-disposition', 'x-export-rows', 'x-export-truncated'],
  });

  app.get('/health', async () => ({ status: 'ok', service: 'arbitron-api' }));

  registerEventRoutes(app, options);
  registerScannerRoutes(app, options);

  return app;
}

function toList(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value;
}

export type { ServerOptions } from './context.js';
