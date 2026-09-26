import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  RATE_LIMIT_PER_MINUTE,
  decideChannel,
  rememberChannel,
  type ServerOptions,
} from './context.js';
import { registerAffiliateRoutes } from './routes/affiliates.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerUpworkAccountRoutes } from './routes/upwork-accounts.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerAutoReplyRoutes } from './routes/auto-reply.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerBriefRoutes } from './routes/briefs.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerDeliveryRoutes } from './routes/delivery.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerEventRoutes } from './routes/events.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerMeRoutes } from './routes/me.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerPlatformAccountRoutes } from './routes/platform-accounts.js';
import { registerPriceBandRoutes } from './routes/price-bands.js';
import { registerPrivacyRoutes } from './routes/privacy.js';
import { registerProposalRoutes } from './routes/proposals.js';
import { registerScannerRoutes } from './routes/scanners.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSourcingPostRoutes } from './routes/sourcing-posts.js';
import { registerSourcingRoutes } from './routes/sourcing.js';
import { registerSupplierRoutes } from './routes/suppliers.js';
import { registerTelegramRoutes } from './routes/telegram.js';
import { registerThreadRoutes } from './routes/threads.js';

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
  const app = Fastify({
    // Behind the host's proxy the caller is in X-Forwarded-For; TRUST_PROXY says how far
    // to believe it, so the rate limit counts callers, not the proxy (ARB-501).
    ...(options.trustProxy === undefined
      ? {}
      : {
          trustProxy:
            typeof options.trustProxy === 'number'
              ? // n proxies in front: trust the n hops nearest this server.
                (_address: string, hop: number) => hop < (options.trustProxy as number)
              : options.trustProxy,
        }),
    logger: options.logger
      ? {
          // A request is logged by method, path and id only: a query string or a header
          // can carry a token or an OAuth code, and those are never logged.
          serializers: {
            req: (request: { method: string; url: string; id: string }) => ({
              method: request.method,
              path: request.url.split('?')[0],
              id: request.id,
            }),
          },
        }
      : false,
  });

  // The browser side of tenancy: only the web app's own origin may call this API, and it
  // signs each request with a bearer token rather than a cookie, so credentials stay off.
  // The three exposed headers are what the CSV export tells the page about the file.
  void app.register(cors, {
    origin: options.webOrigin === undefined ? false : [...toList(options.webOrigin)],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    credentials: false,
    exposedHeaders: ['content-disposition', 'x-export-rows', 'x-export-truncated'],
  });

  app.addHook('onRequest', async (request, reply) => {
    const channel = decideChannel(request, options.mcpChannelKey);
    if (channel === 'refused')
      return reply.code(403).send({
        error:
          "this request claims the MCP channel without its key; set ARBITRON_MCP_CHANNEL_KEY on the MCP server to the API's MCP_CHANNEL_KEY",
      });
    rememberChannel(request, channel);
  });

  // ARB-501, the owner's audit S-04: every caller is limited per minute, the sign-in-free
  // referral click more tightly; the health checks and the payment providers' webhooks
  // are not limited (a provider retries, and a refused webhook is a lost payment).
  void app.register(rateLimit, {
    global: true,
    max: options.rateLimit?.perMinute ?? RATE_LIMIT_PER_MINUTE,
    timeWindow: 60_000,
    allowList: (request) => RATE_LIMIT_EXEMPT.has(request.url.split('?')[0] ?? ''),
  });

  // Routes are registered once the limiter has loaded, so every one of them is limited.
  void app.register(async (scope) => {
    registerRoutes(scope as unknown as FastifyInstance, options);
  });

  return app;
}

const RATE_LIMIT_EXEMPT = new Set([
  '/health',
  '/ready',
  '/v1/webhooks/paystack',
  '/v1/webhooks/stripe',
]);

function registerRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/health', async () => ({ status: 'ok', service: 'arbitron-api' }));
  const ready = options.ready;
  if (ready)
    app.get('/ready', async (_request, reply) => {
      const report = await ready().catch((error: unknown) => ({
        ready: false,
        error: error instanceof Error ? error.message : 'failed',
      }));
      return reply.code(report.ready ? 200 : 503).send({ service: 'arbitron-api', ...report });
    });

  registerMeRoutes(app, options);
  registerOrgRoutes(app, options);
  registerUsageRoutes(app, options);
  registerBillingRoutes(app, options);
  registerAffiliateRoutes(app, options);
  registerDashboardRoutes(app, options);
  registerJobRoutes(app, options);
  registerProposalRoutes(app, options);
  registerMessageRoutes(app, options);
  registerThreadRoutes(app, options);
  registerDiscoveryRoutes(app, options);
  registerBriefRoutes(app, options);
  registerSettingsRoutes(app, options);
  registerAutoReplyRoutes(app, options);
  registerPriceBandRoutes(app, options);
  registerSupplierRoutes(app, options);
  registerSourcingRoutes(app, options);
  registerSourcingPostRoutes(app, options);
  registerDeliveryRoutes(app, options);
  registerPaymentRoutes(app, options);
  registerAnalyticsRoutes(app, options);
  registerTemplateRoutes(app, options);
  registerPlatformAccountRoutes(app, options);
  registerUpworkAccountRoutes(app, options);
  registerEventRoutes(app, options);
  registerPrivacyRoutes(app, options);
  registerScannerRoutes(app, options);
  registerTelegramRoutes(app, options);
}

function toList(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value;
}

export type { ServerOptions } from './context.js';
