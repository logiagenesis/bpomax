import { checkAutoSendGuardrails, validateScanner, type ValidScanner } from '@arbitron/core';
import { recordEvent, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import { invalid, type ServerOptions } from '../context.js';

/**
 * Scanner CRUD (ARB-021).
 *
 * A scanner is a saved search that runs on a timer. With `auto_send` on it can bid
 * without anyone looking first, so the guardrail check is applied to the scanner as it
 * will be after the edit, not to the fields in the request — otherwise switching
 * auto-send on in one call and clearing the cap in the next would slip through.
 *
 * Every change writes an event. That obligation is ARB-014's, and it is met here rather
 * than deferred.
 */
export interface ScannerRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly platform: string;
  readonly filters: Record<string, unknown>;
  readonly poll_interval_seconds: number;
  readonly active: boolean;
  readonly auto_send: boolean;
  readonly min_score: number | null;
  readonly daily_cap: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `id, org_id, name, platform, filters, poll_interval_seconds, active,
                 auto_send, min_score, daily_cap, created_at, updated_at`;

/** The application user behind this session, so events can name a person. */
async function currentUserId(tx: Queryable): Promise<string | null> {
  const { rows } = await tx.query<{ id: string | null }>('select app.current_user_id() as id');
  return rows[0]?.id ?? null;
}

export function registerScannerRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/scanners', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const scanners = await withUser(options.db, authUserId, async (tx) => {
      const { rows } = await tx.query<ScannerRow>(
        `select ${COLUMNS} from scanners order by created_at desc`,
      );
      return rows;
    });
    return reply.send({ scanners });
  });

  app.get('/v1/scanners/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });

    const scanner = await withUser(options.db, authUserId, async (tx) => {
      const { rows } = await tx.query<ScannerRow>(`select ${COLUMNS} from scanners where id = $1`, [
        id,
      ]);
      return rows[0] ?? null;
    });

    // RLS makes "another org's scanner" and "no such scanner" the same answer, which is
    // the right answer: existence is itself information.
    if (!scanner) return reply.code(404).send({ error: 'no such scanner' });
    return reply.send({ scanner });
  });

  app.post('/v1/scanners', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const body = request.body as { orgId?: unknown } & Record<string, unknown>;
    const { orgId, ...fields } = body ?? {};
    if (typeof orgId !== 'string' || !UUID.test(orgId)) {
      return reply.code(400).send({ error: 'orgId is required and must be a uuid' });
    }

    const validated = validateScanner(fields);
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));

    const scanner = validated.value as ValidScanner;
    const guardrails = checkAutoSendGuardrails(scanner);
    if (guardrails.length > 0) return reply.code(422).send(invalid(guardrails));

    try {
      const created = await withUser(options.db, authUserId, async (tx) => {
        const { rows } = await tx.query<ScannerRow>(
          `insert into scanners
             (org_id, name, platform, filters, poll_interval_seconds, active, auto_send, min_score, daily_cap)
           values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
           returning ${COLUMNS}`,
          [
            orgId,
            scanner.name,
            scanner.platform,
            JSON.stringify(scanner.filters),
            scanner.pollIntervalSeconds,
            scanner.active,
            scanner.autoSend,
            scanner.minScore,
            scanner.dailyCap,
          ],
        );
        const row = rows[0];
        if (!row) throw Object.assign(new Error('refused'), { statusCode: 403 });

        await recordEvent(tx, {
          orgId,
          type: 'scanner.created',
          actorUserId: await currentUserId(tx),
          actorKind: 'user',
          subjectTable: 'scanners',
          subjectId: row.id,
          requestId: request.id,
          payload: { name: row.name, auto_send: row.auto_send, daily_cap: row.daily_cap },
        });
        return row;
      });
      return reply.code(201).send({ scanner: created });
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: messageFor(error) });
    }
  });

  app.patch('/v1/scanners/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });

    const validated = validateScanner(request.body, { partial: true });
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));

    const changes = validated.value;
    if (Object.keys(changes).length === 0) {
      return reply.code(422).send(invalid([{ field: '', message: 'no fields to change' }]));
    }

    try {
      const result = await withUser(options.db, authUserId, async (tx) => {
        const existing = await tx.query<ScannerRow>(
          `select ${COLUMNS} from scanners where id = $1`,
          [id],
        );
        const before = existing.rows[0];
        if (!before) return { kind: 'not_found' as const };

        // The guardrail is checked against the scanner as it will be, not against the
        // fields in this request.
        const after = {
          autoSend: changes.autoSend ?? before.auto_send,
          dailyCap: changes.dailyCap ?? before.daily_cap,
          minScore: changes.minScore === undefined ? before.min_score : changes.minScore,
        };
        const guardrails = checkAutoSendGuardrails(after);
        if (guardrails.length > 0) return { kind: 'guardrails' as const, guardrails };

        const sets: string[] = [];
        const params: unknown[] = [];
        const set = (column: string, value: unknown, cast = ''): void => {
          params.push(value);
          sets.push(`${column} = $${String(params.length)}${cast}`);
        };
        if (changes.name !== undefined) set('name', changes.name);
        if (changes.platform !== undefined) set('platform', changes.platform);
        if (changes.filters !== undefined)
          set('filters', JSON.stringify(changes.filters), '::jsonb');
        if (changes.pollIntervalSeconds !== undefined)
          set('poll_interval_seconds', changes.pollIntervalSeconds);
        if (changes.active !== undefined) set('active', changes.active);
        if (changes.autoSend !== undefined) set('auto_send', changes.autoSend);
        if (changes.minScore !== undefined) set('min_score', changes.minScore);
        if (changes.dailyCap !== undefined) set('daily_cap', changes.dailyCap);

        params.push(id);
        const updated = await tx.query<ScannerRow>(
          `update scanners set ${sets.join(', ')} where id = $${String(params.length)}
           returning ${COLUMNS}`,
          params,
        );
        const row = updated.rows[0];
        if (!row) throw Object.assign(new Error('refused'), { statusCode: 403 });

        await recordEvent(tx, {
          orgId: row.org_id,
          type: 'scanner.updated',
          actorUserId: await currentUserId(tx),
          actorKind: 'user',
          subjectTable: 'scanners',
          subjectId: row.id,
          requestId: request.id,
          payload: {
            changed: Object.keys(changes),
            auto_send_before: before.auto_send,
            auto_send_after: row.auto_send,
          },
        });
        return { kind: 'updated' as const, row };
      });

      if (result.kind === 'not_found') return reply.code(404).send({ error: 'no such scanner' });
      if (result.kind === 'guardrails') return reply.code(422).send(invalid(result.guardrails));
      return reply.send({ scanner: result.row });
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: messageFor(error) });
    }
  });

  app.delete('/v1/scanners/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });

    const deleted = await withUser(options.db, authUserId, async (tx) => {
      const actor = await currentUserId(tx);
      const { rows } = await tx.query<ScannerRow>(
        `delete from scanners where id = $1 returning ${COLUMNS}`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;

      await recordEvent(tx, {
        orgId: row.org_id,
        type: 'scanner.deleted',
        actorUserId: actor,
        actorKind: 'user',
        subjectTable: 'scanners',
        subjectId: row.id,
        requestId: request.id,
        payload: { name: row.name },
      });
      return row;
    });

    if (!deleted) return reply.code(404).send({ error: 'no such scanner' });
    return reply.code(204).send();
  });
}

/** Reads the raw driver error, never the friendly message built from it. */
function statusFor(error: unknown): number {
  const message = rawMessage(error);
  if (/row-level security|refused/i.test(message)) return 403;
  if (/duplicate key|unique constraint/i.test(message)) return 409;
  if (/violates check constraint/i.test(message)) return 422;
  return 500;
}

function rawMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageFor(error: unknown): string {
  const message = rawMessage(error);
  if (/scanners_org_id_name_key|duplicate key/i.test(message)) {
    return 'a scanner with that name already exists in this org';
  }
  if (/auto_send_requires_guardrails/i.test(message)) {
    return 'auto-send needs a daily cap and a minimum score';
  }
  if (/row-level security|refused/i.test(message)) {
    return 'you do not have permission to change scanners in this org';
  }
  return message;
}
