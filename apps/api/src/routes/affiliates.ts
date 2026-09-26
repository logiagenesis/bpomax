import { validateAffiliate } from '@arbitron/core';
import {
  affiliateReport,
  loadOrgPlan,
  recordEvent,
  recordReferralClick,
  withUser,
  type Queryable,
} from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import {
  currentMembership,
  invalid,
  REFERRAL_CLICKS_PER_MINUTE,
  UUID,
  type Membership,
  type ServerOptions,
} from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';

/**
 * Affiliates (ARB-430, D-071). A referral link's click is recorded for an anonymous
 * visitor; the programme itself (its affiliates and their report) is the house org's
 * owner's alone.
 */
async function programmeOwner(tx: Queryable, now: Date): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  const plan = await loadOrgPlan(tx, me.orgId, now);
  if (me.role !== 'owner' || plan?.orgPlan.kind !== 'exempt') {
    throw refuse(403, "Only the house organisation's owner runs the affiliate programme.");
  }
  return me;
}

function affiliateOut(row: Awaited<ReturnType<typeof affiliateReport>>[number]) {
  return {
    id: row.id,
    code: row.code,
    ownerEmail: row.owner_email,
    commissionPct: row.commission_pct,
    active: row.active,
    createdAt: row.created_at,
    clicks: row.clicks,
    signUps: row.sign_ups,
    paid: row.paid,
    lastClickAt: row.last_click_at,
  };
}

export function registerAffiliateRoutes(app: FastifyInstance, options: ServerOptions): void {
  const now = () => options.now?.() ?? new Date();

  /** A visit by a referral link. No sign-in: whoever followed the link is not known yet. */
  app.post(
    '/v1/referrals/clicks',
    {
      config: {
        rateLimit: {
          max: options.rateLimit?.clicksPerMinute ?? REFERRAL_CLICKS_PER_MINUTE,
          timeWindow: 60_000,
        },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { code?: unknown; landingPage?: unknown };
      const clickId = await recordReferralClick(options.db, {
        code: typeof body.code === 'string' ? body.code : '',
        landingPage: typeof body.landingPage === 'string' ? body.landingPage : null,
      });
      if (!clickId) return reply.code(404).send({ error: 'That referral code is not in use.' });
      return reply.code(201).send({ clickId });
    },
  );

  app.get('/v1/affiliates', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    try {
      const me = await withUser(options.db, authUserId, (tx) => programmeOwner(tx, now()));
      // The funnel crosses every referred org, so it is read on the service connection,
      // for the owner just checked.
      const rows = await affiliateReport(options.db, me.orgId);
      return reply.send({ affiliates: rows.map(affiliateOut) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  app.post('/v1/affiliates', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const parsed = validateAffiliate(request.body ?? {});
    if (!parsed.ok) return reply.code(422).send(invalid(parsed.errors));
    try {
      const id = await withUser(options.db, authUserId, async (tx) => {
        const me = await programmeOwner(tx, now());
        const taken = await tx.query('select 1 from affiliates where lower(code) = lower($1)', [
          parsed.value.code,
        ]);
        if (taken.rows[0]) throw refuse(409, 'That code is already in use. Choose another.');
        const { rows } = await tx.query<{ id: string }>(
          `insert into affiliates (org_id, code, owner_email, commission_pct)
           values ($1, $2, $3, $4) returning id`,
          [me.orgId, parsed.value.code, parsed.value.ownerEmail, parsed.value.commissionPct],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'affiliate.created',
          actorUserId: me.userId,
          subjectTable: 'affiliates',
          subjectId: rows[0]!.id,
          requestId: request.id,
          payload: { code: parsed.value.code, commissionPct: parsed.value.commissionPct },
        });
        return rows[0]!.id;
      });
      const { rows } = await options.db.query<{ org_id: string }>(
        'select org_id from affiliates where id = $1',
        [id],
      );
      const row = (await affiliateReport(options.db, rows[0]!.org_id)).find((r) => r.id === id);
      return reply.code(201).send({ affiliate: affiliateOut(row!) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /** Switching an affiliate off stops new clicks counting; what it earned stays. */
  app.patch('/v1/affiliates/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const body = (request.body ?? {}) as { active?: unknown };
    if (typeof body.active !== 'boolean') {
      return reply.code(422).send(invalid([{ field: 'active', message: 'must be true or false' }]));
    }
    try {
      await withUser(options.db, authUserId, async (tx) => {
        const me = await programmeOwner(tx, now());
        const { rows } = await tx.query<{ id: string }>(
          'update affiliates set active = $2 where id = $1 and org_id = $3 returning id',
          [id, body.active, me.orgId],
        );
        if (!rows[0]) throw refuse(404, 'no such affiliate');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'affiliate.updated',
          actorUserId: me.userId,
          subjectTable: 'affiliates',
          subjectId: id,
          requestId: request.id,
          payload: { active: body.active },
        });
      });
      return reply.send({ ok: true });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}
