import { PLAN_METRICS, PLAN_METRIC_LABELS, noPlanMessage, usagePeriod } from '@arbitron/core';
import { loadOrgPlan, usedThisMonth, withUser } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, type ServerOptions } from '../context.js';

/**
 * Plan and usage (ARB-410): which plan the org is on, and how much of each metered action
 * it has used this month against the limit. Read by every member; written by nobody here.
 */
export function registerUsageRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/usage', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const now = options.now?.() ?? new Date();

    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const loaded = await loadOrgPlan(tx, me.orgId);
      const orgPlan = loaded?.orgPlan ?? {
        kind: 'none' as const,
        reason: 'no_subscription' as const,
      };
      const metrics = [];
      for (const metric of PLAN_METRICS) {
        const used = await usedThisMonth(tx, me.orgId, metric, now);
        const limit = orgPlan.kind === 'plan' ? orgPlan.plan.limits[metric] : null;
        metrics.push({
          metric,
          label: PLAN_METRIC_LABELS[metric],
          used,
          limit,
          // Whole per cent, rounded down, so 79.9 % never reads as 80 %.
          percent: limit ? Math.floor((used * 100) / limit) : null,
        });
      }
      return { orgPlan, metrics };
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });

    const { orgPlan } = result;
    return reply.send({
      plan:
        orgPlan.kind === 'plan'
          ? {
              kind: 'plan',
              code: orgPlan.plan.code,
              name: orgPlan.plan.name,
              status: orgPlan.status,
            }
          : orgPlan.kind === 'none'
            ? { kind: 'none', reason: orgPlan.reason, message: noPlanMessage(orgPlan.reason) }
            : { kind: 'exempt' },
      period: usagePeriod(now),
      metrics: result.metrics,
    });
  });
}
