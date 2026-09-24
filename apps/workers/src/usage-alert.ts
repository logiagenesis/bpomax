import {
  usageAlertText,
  type BidPeriod,
  type PlanMetric,
  type UsageThreshold,
} from '@arbitron/core';
import { recordEvent, reservePlanUsage, type Queryable } from '@arbitron/db';
import { isEmailAddress, type EmailSender } from '@arbitron/email';

/**
 * Plan usage alerts (ARB-410: "80%/100% alerts"). A metered action that takes an org
 * across 80 % or 100 % of a monthly limit records `usage.threshold_reached`, and the
 * org's owners are told: on Telegram, in every linked chat, and by email when a provider
 * exists (docs/02 B-13; until then the event says email was not sent, and why).
 */
export interface UsageAlert {
  readonly orgId: string;
  readonly orgName: string;
  readonly planName: string;
  readonly metric: PlanMetric;
  readonly threshold: UsageThreshold;
  readonly used: number;
  readonly limit: number;
  readonly period: BidPeriod;
  readonly requestId?: string | null;
}

export interface UsageAlertDeps {
  readonly db: Queryable;
  /** Sends one Telegram message (the bot's `sendMessage`). Absent without B-09's token. */
  readonly telegram?: ((chatId: string, text: string) => Promise<unknown>) | null;
  /** Absent until an email provider is chosen (B-13). */
  readonly email?: EmailSender | null;
  /** Why email is off, from `emailConfig`, for the event. */
  readonly emailOffReason?: string;
}

export interface AlertOutcome {
  readonly telegram: number;
  readonly email: number;
  readonly failures: number;
}

/** Tells the org's owners, and records how many were told and by what. Never throws. */
export function createUsageAlert(
  deps: UsageAlertDeps,
): (alert: UsageAlert) => Promise<AlertOutcome> {
  return async (alert) => {
    const { rows } = await deps.db.query<{ email: string | null; chat_id: string | null }>(
      `select u.email, u.telegram_chat_id as chat_id
         from memberships m join users u on u.id = m.user_id
        where m.org_id = $1 and m.role = 'owner'`,
      [alert.orgId],
    );
    const text = usageAlertText(alert);
    let telegram = 0;
    let email = 0;
    let failures = 0;
    for (const owner of rows) {
      if (deps.telegram && owner.chat_id) {
        try {
          await deps.telegram(owner.chat_id, `${text.subject}\n\n${text.body}`);
          telegram += 1;
        } catch {
          failures += 1;
        }
      }
      if (deps.email && isEmailAddress(owner.email)) {
        try {
          await deps.email.send({ to: owner.email, subject: text.subject, text: text.body });
          email += 1;
        } catch {
          failures += 1;
        }
      }
    }
    // Counts only: an address or a chat id is not written into the audit log.
    await recordEvent(deps.db, {
      orgId: alert.orgId,
      type: 'usage.alert_sent',
      requestId: alert.requestId ?? null,
      outcome: failures > 0 ? 'error' : telegram + email > 0 ? 'ok' : 'skipped',
      payload: {
        metric: alert.metric,
        threshold: alert.threshold,
        owners: rows.length,
        telegram,
        email,
        failures,
        ...(deps.telegram ? {} : { telegramOff: 'no Telegram bot token (docs/02 B-09)' }),
        ...(deps.email
          ? {}
          : { emailOff: deps.emailOffReason ?? 'no email provider (docs/02 B-13)' }),
      },
    });
    return { telegram, email, failures };
  };
}

export interface MeterDeps {
  readonly db: Queryable;
  readonly usageAlert?: ((alert: UsageAlert) => Promise<unknown>) | null;
}

/**
 * Takes one metered action for an org (ARB-410), records each threshold it crosses and
 * hands it to the alert. A refusal is returned for the worker to record against its own
 * subject; the counter is not touched.
 */
export async function meter(
  deps: MeterDeps,
  input: { orgId: string; metric: PlanMetric; now?: Date; requestId?: string | null },
) {
  const reservation = await reservePlanUsage(deps.db, {
    orgId: input.orgId,
    metric: input.metric,
    ...(input.now ? { now: input.now } : {}),
  });
  const { verdict } = reservation;
  if (verdict.ok && verdict.limit !== null) {
    for (const threshold of reservation.crossed) {
      await recordEvent(deps.db, {
        orgId: input.orgId,
        type: 'usage.threshold_reached',
        requestId: input.requestId ?? null,
        outcome: 'ok',
        payload: {
          metric: input.metric,
          threshold,
          used: verdict.used,
          limit: verdict.limit,
          periodStart: verdict.period.start,
          plan: reservation.planName,
        },
      });
      if (deps.usageAlert) {
        try {
          await deps.usageAlert({
            orgId: input.orgId,
            orgName: reservation.orgName,
            planName: reservation.planName ?? '',
            metric: input.metric,
            threshold,
            used: verdict.used,
            limit: verdict.limit,
            period: verdict.period,
            requestId: input.requestId ?? null,
          });
        } catch {
          // An alert that cannot be sent never undoes the action it reports.
        }
      }
    }
  }
  return verdict;
}
