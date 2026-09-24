import {
  liveModeBlockers,
  validateMarginRules,
  validatePlanRecord,
  type MarginRulesInput,
} from '@arbitron/core';
import { recordEvent, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { currentMembership, invalid, UUID, type ServerOptions } from '../context.js';
import { messageOf, refuse, statusOf } from '../errors.js';
import { freelancerStatus } from './platform-accounts.js';
import { upworkStatus } from './upwork-accounts.js';

/**
 * Settings (ARB-061, docs/01 section I): platform accounts, margin rules, the fee table,
 * the FX buffer and the live-mode switch. Scanners have their own routes (ARB-021) and
 * the Telegram link its own (ARB-050); this file is the rest.
 *
 * The rules a form is held to are `@arbitron/core`'s, run here and in the browser from
 * the same code (05 section 1.5). RLS makes settings owner-only (0008); the API does
 * not repeat that check, it reports the refusal.
 */
interface SettingsRow {
  readonly org_id: string;
  readonly min_margin_pct: string | null;
  readonly min_margin_zar_minor: string | null;
  readonly fx_buffer_pct: string | null;
  readonly vat_pct: string;
  readonly retention_days: number | null;
  readonly fee_table: unknown[];
  readonly live_mode: boolean;
  readonly bidding_paused: boolean;
  readonly updated_at: string | null;
}

interface AccountRow {
  readonly id: string;
  readonly platform: string;
  readonly external_user_id: string;
  readonly external_username?: string | null;
  readonly status: string;
  readonly scopes: string[];
  readonly last_sync_at: string | null;
  readonly plan_name: string | null;
  readonly monthly_bid_allowance: number | null;
  readonly plan_recorded_on: string | null;
}

const SETTINGS_COLUMNS = `org_id, min_margin_pct::text, min_margin_zar_minor::text, fx_buffer_pct::text,
  vat_pct::text, retention_days, fee_table, live_mode, bidding_paused, updated_at`;

/** The org's settings row, or the defaults the database would give it. */
async function readSettings(tx: Queryable, orgId: string): Promise<SettingsRow> {
  const { rows } = await tx.query<SettingsRow>(
    `select ${SETTINGS_COLUMNS} from settings where org_id = $1`,
    [orgId],
  );
  return (
    rows[0] ?? {
      org_id: orgId,
      min_margin_pct: null,
      min_margin_zar_minor: null,
      fx_buffer_pct: null,
      vat_pct: '15.000',
      retention_days: null,
      fee_table: [],
      live_mode: false,
      bidding_paused: false,
      updated_at: null,
    }
  );
}

function describe(row: SettingsRow) {
  return {
    minMarginPct: row.min_margin_pct,
    minMarginZarMinor: row.min_margin_zar_minor,
    fxBufferPct: row.fx_buffer_pct,
    vatPct: row.vat_pct,
    retentionDays: row.retention_days,
    feeTable: row.fee_table,
    liveMode: row.live_mode,
    biddingPaused: row.bidding_paused,
    updatedAt: row.updated_at,
  };
}

function blockers(row: SettingsRow): string[] {
  return liveModeBlockers({
    minMarginPct: row.min_margin_pct,
    minMarginZarMinor: row.min_margin_zar_minor,
    fxBufferPct: row.fx_buffer_pct,
    feeTableLength: Array.isArray(row.fee_table) ? row.fee_table.length : 0,
    retentionDays: row.retention_days,
  });
}

const COLUMN_FOR: Record<keyof MarginRulesInput, string> = {
  minMarginPct: 'min_margin_pct',
  minMarginZarMinor: 'min_margin_zar_minor',
  fxBufferPct: 'fx_buffer_pct',
  vatPct: 'vat_pct',
  retentionDays: 'retention_days',
  feeTable: 'fee_table',
};

export function registerSettingsRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/settings', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const result = await withUser(options.db, authUserId, async (tx) => {
      const me = await currentMembership(tx);
      if (!me) return null;
      const row = await readSettings(tx, me.orgId);
      const accounts = await tx.query<AccountRow>(
        `select id, platform::text as platform, external_user_id, external_username,
                status::text as status, scopes, last_sync_at, plan_name, monthly_bid_allowance,
                plan_recorded_on::text
         from platform_accounts order by platform`,
      );
      return { me, row, accounts: accounts.rows };
    });
    if (!result) return reply.code(403).send({ error: 'you are not a member of an organisation' });

    return reply.send({
      settings: describe(result.row),
      liveModeBlockers: blockers(result.row),
      environmentLiveMode: options.liveMode ?? false,
      accounts: result.accounts.map((account) => ({
        id: account.id,
        platform: account.platform,
        externalUserId: account.external_user_id,
        externalUsername: account.external_username,
        status: account.status,
        scopes: account.scopes,
        lastSyncAt: account.last_sync_at,
        planName: account.plan_name,
        monthlyBidAllowance: account.monthly_bid_allowance,
        planRecordedOn: account.plan_recorded_on,
      })),
      telegramLinked: result.me.telegramLinked,
      role: result.me.role,
      freelancer: freelancerStatus(options),
      upwork: upworkStatus(options),
    });
  });

  app.patch('/v1/settings', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const validated = validateMarginRules(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const changes = validated.value;
    // The table is stored as it was sent, once parseFeeTable has accepted every row.
    const rawFeeTable = (request.body as { feeTable?: unknown }).feeTable;

    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        const before = await readSettings(tx, me.orgId);

        const columns: string[] = [];
        const values: unknown[] = [me.orgId];
        const casts: string[] = [];
        for (const key of Object.keys(changes) as (keyof MarginRulesInput)[]) {
          columns.push(COLUMN_FOR[key]);
          if (key === 'feeTable') {
            values.push(JSON.stringify(rawFeeTable));
            casts.push('::jsonb');
          } else {
            values.push(changes[key]);
            casts.push('');
          }
        }
        const placeholders = columns.map((_, i) => `$${String(i + 2)}${casts[i]}`);
        const { rows } = await tx.query<SettingsRow>(
          `insert into settings (org_id, ${columns.join(', ')})
           values ($1, ${placeholders.join(', ')})
           on conflict (org_id) do update set ${columns.map((c, i) => `${c} = ${placeholders[i]}`).join(', ')}
           returning ${SETTINGS_COLUMNS}`,
          values,
        );
        const row = rows[0];
        if (!row) throw refuse(403, 'only an owner can change settings');

        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'settings.changed',
          actorUserId: me.userId,
          subjectTable: 'settings',
          requestId: request.id,
          payload: {
            via: 'web',
            changed: Object.keys(changes),
            before: describe(before),
            after: describe(row),
          },
        });
        return row;
      });
      return reply.send({ settings: describe(result), liveModeBlockers: blockers(result) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /**
   * The org's live-mode switch (D-032: one of two, the other is the environment's). Off
   * to on is refused, with the list, while any rule is missing; the database holds the
   * same rule (0007, 0010) in case anything else tries. Every change is an event with
   * the person named: this is the switch that lets money move.
   */
  app.post('/v1/settings/live-mode', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const live = (request.body as { live?: unknown } | null)?.live;
    if (typeof live !== 'boolean') {
      return reply.code(422).send(invalid([{ field: 'live', message: 'must be true or false' }]));
    }

    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        const before = await readSettings(tx, me.orgId);
        if (live) {
          const missing = blockers(before);
          if (missing.length > 0) {
            throw refuse(
              422,
              `Live mode needs ${missing.join(', ')} before it can be switched on.`,
            );
          }
        }
        // An update, not an upsert: Postgres checks the constraints on the proposed
        // insert row, whose defaults have no rules, before it looks for the conflict.
        let { rows } = await tx.query<SettingsRow>(
          `update settings set live_mode = $2 where org_id = $1 returning ${SETTINGS_COLUMNS}`,
          [me.orgId, live],
        );
        if (!rows[0] && before.updated_at === null) {
          rows = (
            await tx.query<SettingsRow>(
              `insert into settings (org_id, live_mode) values ($1, $2) returning ${SETTINGS_COLUMNS}`,
              [me.orgId, live],
            )
          ).rows;
        }
        const row = rows[0];
        if (!row) throw refuse(403, 'only an owner can switch live mode');
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'live_mode.changed',
          actorUserId: me.userId,
          subjectTable: 'settings',
          requestId: request.id,
          payload: { via: 'web', live_before: before.live_mode, live_after: row.live_mode },
        });
        return row;
      });
      return reply.send({ settings: describe(result), liveModeBlockers: blockers(result) });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });

  /**
   * The plan and monthly bid allowance on a platform account (D-030, docs/02 T-03). Read
   * from the platform's own membership page by the owner; the day it was recorded is
   * stored with it so a stale figure shows its age.
   */
  app.patch('/v1/platform-accounts/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });

    const validated = validatePlanRecord(request.body);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const { planName, monthlyBidAllowance } = validated.value;

    try {
      const account = await withUser(options.db, authUserId, async (tx) => {
        const me = await currentMembership(tx);
        if (!me) throw refuse(403, 'you are not a member of an organisation');
        const { rows } = await tx.query<AccountRow>(
          `update platform_accounts
           set plan_name = $2, monthly_bid_allowance = $3, plan_recorded_on = $4::date
           where id = $1
           returning id, platform::text as platform, external_user_id, status::text as status, scopes,
                     last_sync_at, plan_name, monthly_bid_allowance, plan_recorded_on::text`,
          [id, planName, monthlyBidAllowance, todayIso(options.now ? options.now() : new Date())],
        );
        const row = rows[0];
        if (!row) {
          const exists = await tx.query<{ id: string }>(
            'select id from platform_accounts where id = $1',
            [id],
          );
          throw exists.rows[0]
            ? refuse(403, 'your role cannot change platform accounts')
            : refuse(404, 'no such platform account');
        }
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'settings.changed',
          actorUserId: me.userId,
          subjectTable: 'platform_accounts',
          subjectId: row.id,
          requestId: request.id,
          payload: {
            via: 'web',
            what: 'plan_recorded',
            plan_name: row.plan_name,
            monthly_bid_allowance: row.monthly_bid_allowance,
          },
        });
        return row;
      });
      return reply.send({
        account: {
          id: account.id,
          platform: account.platform,
          externalUserId: account.external_user_id,
          status: account.status,
          scopes: account.scopes,
          lastSyncAt: account.last_sync_at,
          planName: account.plan_name,
          monthlyBidAllowance: account.monthly_bid_allowance,
          planRecordedOn: account.plan_recorded_on,
        },
      });
    } catch (error) {
      return reply.code(statusOf(error)).send({ error: messageOf(error) });
    }
  });
}

/** Today's date in South Africa (D-024's fixed +02:00), as YYYY-MM-DD. */
function todayIso(now: Date): string {
  return new Date(now.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
}
