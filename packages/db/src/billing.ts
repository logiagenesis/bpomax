import {
  nextSubscriptionState,
  type BillingCurrency,
  type BillingProvider,
  type BillingSignal,
  type SubscriptionStatus,
} from '@arbitron/core';
import type { Queryable } from './client.js';
import { recordEvent } from './events.js';

/**
 * Billing records (ARB-420): the org's subscription as the providers' webhooks move it,
 * and the daily sweep that ends a plan whose grace period ran out. All of it is the
 * system's to write (0033, 0034): these run on the API's service connection or in the
 * workers, never under a person's session.
 */
export async function graceDays(db: Queryable): Promise<number | null> {
  const { rows } = await db.query<{ grace_days: number | null }>(
    'select grace_days from billing_settings limit 1',
  );
  return rows[0]?.grace_days ?? null;
}

/** Records a webhook delivery once; false when the same one was seen before. */
export async function recordWebhookReceipt(
  db: Queryable,
  input: {
    provider: BillingProvider;
    eventKey: string;
    eventType: string;
    orgId: string | null;
    outcome: 'ok' | 'skipped' | 'error';
    detail?: string | null;
  },
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `insert into billing_webhook_receipts (provider, event_key, event_type, org_id, outcome, detail)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (provider, event_key) do nothing
     returning id`,
    [
      input.provider,
      input.eventKey,
      input.eventType,
      input.orgId,
      input.outcome,
      input.detail ?? null,
    ],
  );
  return rows.length > 0;
}

export async function seenWebhook(
  db: Queryable,
  provider: BillingProvider,
  eventKey: string,
): Promise<boolean> {
  const { rows } = await db.query(
    'select 1 from billing_webhook_receipts where provider = $1 and event_key = $2',
    [provider, eventKey],
  );
  return rows.length > 0;
}

export interface CheckoutRow {
  id: string;
  org_id: string;
  provider: BillingProvider;
  plan_code: string;
  currency: BillingCurrency;
  reference: string;
  status: string;
}

export async function findCheckout(
  db: Queryable,
  by: { reference: string } | { id: string },
): Promise<CheckoutRow | null> {
  const { rows } = await db.query<CheckoutRow>(
    `select id, org_id, provider, plan_code, currency::text as currency, reference, status
       from billing_checkouts where ${'reference' in by ? 'reference' : 'id'} = $1`,
    ['reference' in by ? by.reference : by.id],
  );
  return rows[0] ?? null;
}

/** The first payment went through: the org is on the plan it chose (ARB-420 acceptance). */
export async function activatePlan(
  db: Queryable,
  input: {
    checkout: CheckoutRow;
    externalRef: string | null;
    externalCustomer: string | null;
    requestId?: string | null;
  },
): Promise<void> {
  const { checkout } = input;
  await db.query(
    `insert into subscriptions (org_id, plan, status, provider, currency, external_ref,
                                external_customer, grace_until)
     values ($1, $2, 'active', $3, $4, $5, $6, null)
     on conflict (org_id) do update set
       plan = excluded.plan, status = 'active', provider = excluded.provider,
       currency = excluded.currency, external_ref = excluded.external_ref,
       external_customer = excluded.external_customer, grace_until = null`,
    [
      checkout.org_id,
      checkout.plan_code,
      checkout.provider,
      checkout.currency,
      input.externalRef,
      input.externalCustomer,
    ],
  );
  await db.query(`update billing_checkouts set status = 'completed' where id = $1`, [checkout.id]);
  await recordEvent(db, {
    orgId: checkout.org_id,
    type: 'billing.plan_activated',
    subjectTable: 'billing_checkouts',
    subjectId: checkout.id,
    requestId: input.requestId ?? null,
    outcome: 'ok',
    payload: {
      plan: checkout.plan_code,
      provider: checkout.provider,
      currency: checkout.currency,
    },
  });
}

interface SubscriptionRow {
  id: string;
  org_id: string;
  status: SubscriptionStatus;
  grace_until: Date | string | null;
  plan: string;
}

export type SubscriptionMatch =
  | { readonly provider: BillingProvider; readonly externalRef: string }
  | { readonly provider: BillingProvider; readonly externalCustomer: string };

async function findSubscription(db: Queryable, match: SubscriptionMatch) {
  const byRef = 'externalRef' in match;
  const { rows } = await db.query<SubscriptionRow>(
    `select id, org_id, status, grace_until, plan from subscriptions
      where provider = $1 and ${byRef ? 'external_ref' : 'external_customer'} = $2
      order by updated_at desc limit 1`,
    [match.provider, byRef ? match.externalRef : match.externalCustomer],
  );
  return rows[0] ?? null;
}

/**
 * A provider's later word on a subscription: paid, a failed payment, or the end. Returns
 * the org it applied to, or null when no subscription matches (the event is then
 * acknowledged and recorded as skipped: it may belong to another product on the same
 * account).
 */
export async function applyBillingSignal(
  db: Queryable,
  input: {
    match: SubscriptionMatch;
    signal: BillingSignal;
    now: Date;
    graceDays: number | null;
    /** The provider's subscription reference, when learned from this event. */
    externalRef?: string | null;
    requestId?: string | null;
  },
): Promise<{ orgId: string; status: SubscriptionStatus; graceUntil: Date | null } | null> {
  const row = await findSubscription(db, input.match);
  if (!row) return null;
  const current = {
    status: row.status,
    graceUntil: row.grace_until === null ? null : new Date(row.grace_until),
  };
  const next = nextSubscriptionState(current, input.signal, input.now, input.graceDays);
  await db.query(
    `update subscriptions set status = $2, grace_until = $3,
            external_ref = coalesce($4, external_ref)
      where id = $1`,
    [row.id, next.status, next.graceUntil?.toISOString() ?? null, input.externalRef ?? null],
  );
  const type =
    input.signal === 'payment_failed'
      ? 'billing.payment_failed'
      : input.signal === 'ended'
        ? 'billing.cancelled'
        : current.status === 'past_due'
          ? 'billing.payment_recovered'
          : null;
  if (type && (type !== 'billing.payment_failed' || current.status !== 'past_due')) {
    await recordEvent(db, {
      orgId: row.org_id,
      type,
      subjectTable: 'subscriptions',
      subjectId: row.id,
      requestId: input.requestId ?? null,
      outcome: 'ok',
      payload: {
        plan: row.plan,
        status: next.status,
        graceUntil: next.graceUntil?.toISOString() ?? null,
      },
    });
  }
  return { orgId: row.org_id, status: next.status, graceUntil: next.graceUntil };
}

/**
 * The daily sweep: every plan whose grace period has run out is cancelled and recorded
 * as `billing.downgraded` ("failed payment downgrades after grace period"). The plan has
 * already stopped working at that moment (`loadOrgPlan`); this makes the record say so.
 */
export async function downgradeExpired(
  db: Queryable,
  now: Date,
): Promise<{ orgId: string; plan: string }[]> {
  const { rows } = await db.query<{ id: string; org_id: string; plan: string }>(
    `update subscriptions set status = 'cancelled', grace_until = null
      where status = 'past_due' and grace_until is not null and grace_until <= $1
      returning id, org_id, plan`,
    [now.toISOString()],
  );
  for (const row of rows) {
    await recordEvent(db, {
      orgId: row.org_id,
      type: 'billing.downgraded',
      subjectTable: 'subscriptions',
      subjectId: row.id,
      outcome: 'ok',
      payload: { plan: row.plan, reason: 'grace_ended' },
    });
  }
  return rows.map((row) => ({ orgId: row.org_id, plan: row.plan }));
}
