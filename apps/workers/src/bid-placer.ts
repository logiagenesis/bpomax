import { minorToCsvAmount, type BidPayload } from '@arbitron/core';
import type { Queryable } from '@arbitron/db';
import {
  AccountNotConnectedError,
  createBid,
  findBid,
  freelancerAccessToken,
  type Fetch,
  type FreelancerConfig,
} from '@arbitron/freelancer';
import { UnrecoverableError } from 'bullmq';
import type { BidPlacer } from './submit.js';

/**
 * The Freelancer.com bid placer (ARB-511, the owner's audit E-04 and E-05), the adapter
 * the submit worker calls once the approval, the caps, the live gate and the allowance
 * have all said yes. It never decides whether to bid; it only places the bid it is given,
 * with the documented create-bid call (packages/freelancer/src/bidding.ts).
 *
 * The crash window (E-05): the platform can accept a bid and the process die before the
 * worker writes that down. So before placing, the placer asks the platform for a bid by
 * this account on this project, and if there is one it answers with that bid instead of
 * placing another. The worker's own record is checked first (submit.ts); this covers the
 * moment between the platform's answer and the record.
 *
 * What the call needs and the worker does not have: the platform's numeric project id
 * (`jobs.external_id`), the bidder's id (`platform_accounts.external_user_id`) and a
 * valid token. The amount goes in the project's currency units, as the documented
 * example sends them; a bid in any other currency than the project's is refused, as no
 * rate may be assumed. `milestone_percentage` is the first milestone's share of the
 * total, rounded down to a whole percent (the documented example is a whole number), or
 * 100 for a bid without milestones (D-077).
 */
export interface FreelancerPlacerDeps {
  /** A service-role connection: the placer acts for whichever org owns the proposal. */
  readonly db: Queryable;
  readonly config: FreelancerConfig;
  readonly fetch?: Fetch;
  readonly now?: () => Date;
}

interface PlacementRow {
  readonly org_id: string;
  readonly job_currency: string | null;
  readonly account_id: string | null;
  readonly bidder_id: string | null;
}

export function milestonePercentage(
  payload: Pick<BidPayload, 'amountMinor' | 'milestones'>,
): number {
  const first = payload.milestones[0];
  if (!first || payload.amountMinor <= 0) return 100;
  return Math.max(1, Math.floor((first.amount_minor * 100) / payload.amountMinor));
}

export function freelancerBidPlacer(deps: FreelancerPlacerDeps): BidPlacer {
  return {
    async placeBid(payload) {
      if (payload.platform !== 'freelancer')
        throw new UnrecoverableError(`the Freelancer.com placer cannot bid on ${payload.platform}`);
      const projectId = Number(payload.jobExternalId);
      if (!Number.isInteger(projectId) || projectId <= 0)
        throw new UnrecoverableError(
          `project id ${payload.jobExternalId} is not a Freelancer.com id`,
        );

      const { rows } = await deps.db.query<PlacementRow>(
        `select p.org_id, j.currency::text as job_currency, a.id as account_id,
                a.external_user_id as bidder_id
           from proposals p
           join jobs j on j.id = p.job_id
           left join platform_accounts a
             on a.org_id = p.org_id and a.platform = 'freelancer' and a.status = 'connected'
          where p.id = $1`,
        [payload.proposalId],
      );
      const row = rows[0];
      if (!row) throw new UnrecoverableError(`proposal ${payload.proposalId} does not exist`);
      if (!row.account_id || !row.bidder_id)
        throw new UnrecoverableError(
          'No Freelancer.com account is connected for this organisation. Connect one in Settings and approve the bid again.',
        );
      const bidderId = Number(row.bidder_id);
      if (!Number.isInteger(bidderId))
        throw new UnrecoverableError('the connected Freelancer.com account has no numeric user id');
      const projectCurrency = row.job_currency?.trim().toUpperCase() ?? null;
      if (projectCurrency !== payload.currency.trim().toUpperCase())
        throw new UnrecoverableError(
          `The bid is in ${payload.currency} but the project is in ${projectCurrency ?? 'an unknown currency'}; a bid is placed in the project's currency.`,
        );

      let token: string;
      try {
        token = await freelancerAccessToken(
          {
            db: deps.db,
            config: deps.config,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            ...(deps.now ? { now: deps.now } : {}),
          },
          row.account_id,
        );
      } catch (error) {
        if (error instanceof AccountNotConnectedError) throw new UnrecoverableError(error.message);
        throw error;
      }
      const call = deps.fetch ? { fetch: deps.fetch } : {};

      const earlier = await findBid(deps.config, token, { projectId, bidderId }, call);
      if (earlier) return { platformRef: earlier.id, reconciled: true };

      const placed = await createBid(
        deps.config,
        token,
        {
          projectId,
          bidderId,
          amount: Number(minorToCsvAmount(String(payload.amountMinor), payload.currency)),
          period: payload.deliveryDays,
          milestonePercentage: milestonePercentage(payload),
          description: payload.body,
        },
        call,
      );
      return { platformRef: placed.id };
    },
  };
}
