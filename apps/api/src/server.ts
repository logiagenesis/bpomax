import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { decideChannel, rememberChannel, type ServerOptions } from './context.js';
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

  app.addHook('onRequest', async (request, reply) => {
    const channel = decideChannel(request, options.mcpChannelKey);
    if (channel === 'refused')
      return reply.code(403).send({
        error:
          "this request claims the MCP channel without its key; set ARBITRON_MCP_CHANNEL_KEY on the MCP server to the API's MCP_CHANNEL_KEY",
      });
    rememberChannel(request, channel);
  });

  app.get('/health', async () => ({ status: 'ok', service: 'arbitron-api' }));

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
  registerScannerRoutes(app, options);
  registerTelegramRoutes(app, options);

  return app;
}

function toList(value: string | readonly string[]): readonly string[] {
  return typeof value === 'string' ? [value] : value;
}

export type { ServerOptions } from './context.js';
