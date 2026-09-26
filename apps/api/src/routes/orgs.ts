import { onboardingSteps, validateNewOrg } from '@arbitron/core';
import { recordPublishedTerms, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import {
  currentMembership,
  invalid,
  UUID,
  type FieldProblem,
  type ServerOptions,
} from '../context.js';
import { describeMembership } from './me.js';

/**
 * Public sign-up, second half (ARB-400). The person has an identity from Supabase Auth
 * (`POST /auth/v1/signup`, on the sign-up page) and, through migration 0009's trigger, an
 * application user with no org. Here they create their org and become its owner.
 *
 * The work is `app.create_org` (migration 0032), called under the person's own session,
 * so the database decides who it is for: the route passes a name and a country, never a
 * user or an org id. Since ARB-522 it also passes the version of the terms of service the
 * person accepted, and the database makes the org only for the version on show.
 */
function refusal(
  error: unknown,
): { status: number; error: string; errors?: readonly FieldProblem[] } | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/terms of service are not published yet/.test(message)) {
    return {
      status: 409,
      error:
        'Organisations cannot be made until the terms of service are published. An owner can add you to theirs.',
    };
  }
  if (/accept the current terms of service/.test(message)) {
    return {
      ...invalid([
        {
          field: 'terms',
          message: 'must be the terms of service on show now: reload the page and accept them',
        },
      ]),
      status: 422,
    };
  }
  if (/already a member of an organisation/.test(message)) {
    return {
      status: 409,
      error: 'You are already a member of an organisation. Sign in to use it.',
    };
  }
  if (/sign in first/.test(message)) {
    return {
      status: 403,
      error: 'This sign-in has no account behind it yet. Sign out, sign in again, then retry.',
    };
  }
  return null;
}

export interface OnboardingFactsRow {
  margin_rules_set: boolean;
  freelancer_connected: boolean;
  scanner_count: number;
  active_template_count: number;
}

/** Read from the org's own rows, inside the person's session. */
async function onboardingFacts(tx: Queryable, orgId: string): Promise<OnboardingFactsRow> {
  const { rows } = await tx.query<OnboardingFactsRow>(
    `select
       coalesce((select s.min_margin_pct is not null
                        and s.min_margin_zar_minor is not null
                        and s.fx_buffer_pct is not null
                        and jsonb_array_length(s.fee_table) > 0
                   from settings s where s.org_id = $1), false) as margin_rules_set,
       exists (select 1 from platform_accounts a
                where a.org_id = $1 and a.platform = 'freelancer' and a.status = 'connected')
         as freelancer_connected,
       (select count(*)::int from scanners c where c.org_id = $1) as scanner_count,
       (select count(*)::int from templates t
         where t.org_id = $1 and t.active
           and exists (select 1 from template_variants v
                        where v.template_id = t.id and v.active)) as active_template_count`,
    [orgId],
  );
  return rows[0]!;
}

export function registerOrgRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.post('/v1/orgs', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const parsed = validateNewOrg(request.body ?? {});
    if (!parsed.ok) return reply.code(422).send(invalid(parsed.errors));

    try {
      // The version on show is recorded first (once; recording it again changes nothing),
      // so the database knows what to hold the new owner to.
      if (options.terms) await recordPublishedTerms(options.db, options.terms);
      const me = await withUser(options.db, authUserId, async (tx) => {
        // ARB-430: the referral click this browser kept, if any; create_org takes it only
        // while it is attached to no org.
        const referral = (request.body as { referral?: unknown } | null)?.referral;
        await tx.query(`select app.create_org($1, $2, $3, $4, $5)`, [
          parsed.value.name,
          parsed.value.countryCode,
          request.id,
          typeof referral === 'string' && UUID.test(referral) ? referral : null,
          parsed.value.termsVersion,
        ]);
        return currentMembership(tx);
      });
      if (!me) return reply.code(500).send({ error: 'the organisation was not created' });
      return reply.code(201).send(describeMembership(me));
    } catch (error) {
      const refused = refusal(error);
      if (refused) {
        const { status, ...body } = refused;
        return reply.code(status).send(body);
      }
      throw error;
    }
  });

  /** What is left to set up, for the onboarding page (ARB-400). */
  app.get('/v1/onboarding', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      return { me, facts: await onboardingFacts(tx, me.orgId) };
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });

    const steps = onboardingSteps({
      marginRulesSet: result.facts.margin_rules_set,
      freelancerConnected: result.facts.freelancer_connected,
      scannerCount: result.facts.scanner_count,
      activeTemplateCount: result.facts.active_template_count,
      telegramLinked: result.me.telegramLinked,
    });
    return reply.send({ ...describeMembership(result.me), steps });
  });
}
