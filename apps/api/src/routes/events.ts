import { EVENT_OUTCOMES, isEventType, type EventOutcome, type EventType } from '@arbitron/core';
import {
  EVENTS_PAGE_LIMIT,
  listEventActors,
  listEvents,
  withUser,
  type EventFilters,
  type EventRow,
} from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from '../context.js';
import { EXPORT_ROW_CAP, eventsToCsv } from './events-csv.js';

interface EventQuery {
  type?: string;
  actor?: string;
  subject_table?: string;
  subject_id?: string;
  outcome?: string;
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
}

function parseTimestamp(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw Object.assign(new Error(`${field} is not a date`), { statusCode: 400 });
  }
  return value;
}

function parseCount(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error(`${field} must be a whole number of zero or more`), {
      statusCode: 400,
    });
  }
  return parsed;
}

type ParsedFilters = { ok: true; filters: EventFilters } | { ok: false; error: string };

/** The query-string filters shared by the JSON list and the CSV export. */
function parseFilters(query: EventQuery): ParsedFilters {
  let types: EventType[] | undefined;
  if (query.type !== undefined) {
    const requested = query.type.split(',').map((value) => value.trim());
    const unknown = requested.filter((value) => !isEventType(value));
    if (unknown.length > 0)
      return { ok: false, error: `unknown event type: ${unknown.join(', ')}` };
    types = requested as EventType[];
  }

  if (query.outcome !== undefined && !EVENT_OUTCOMES.includes(query.outcome as EventOutcome)) {
    return { ok: false, error: `unknown outcome: ${query.outcome}` };
  }

  try {
    const from = parseTimestamp(query.from, 'from');
    const to = parseTimestamp(query.to, 'to');
    const limit = parseCount(query.limit, 'limit');
    const offset = parseCount(query.offset, 'offset');
    return {
      ok: true,
      filters: {
        ...(types ? { type: types } : {}),
        ...(query.actor ? { actorUserId: query.actor } : {}),
        ...(query.subject_table ? { subjectTable: query.subject_table } : {}),
        ...(query.subject_id ? { subjectId: query.subject_id } : {}),
        ...(query.outcome ? { outcome: query.outcome as EventOutcome } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      },
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** ARB-014: the audit log viewer. ARB-062: its actor list and CSV export. */
export function registerEventRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/events', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const parsed = parseFilters(request.query as EventQuery);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { filters } = parsed;

    const events = await withUser(options.db, authUserId, (tx) => listEvents(tx, filters));

    return reply.send({
      events,
      page: { limit: filters.limit ?? EVENTS_PAGE_LIMIT, offset: filters.offset ?? 0 },
    });
  });

  app.get('/v1/events/actors', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const actors = await withUser(options.db, authUserId, (tx) => listEventActors(tx));
    return reply.send({ actors });
  });

  app.get('/v1/events.csv', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const parsed = parseFilters(request.query as EventQuery);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    // Paging is the export's own business: it reads every matching row up to the cap.
    const { limit: _limit, offset: _offset, ...filters } = parsed.filters;

    const { rows, truncated } = await withUser(options.db, authUserId, async (tx) => {
      const collected: EventRow[] = [];
      for (;;) {
        const page = await listEvents(tx, {
          ...filters,
          limit: EVENTS_PAGE_LIMIT,
          offset: collected.length,
        });
        collected.push(...page);
        if (page.length < EVENTS_PAGE_LIMIT) return { rows: collected, truncated: false };
        if (collected.length >= EXPORT_ROW_CAP) {
          return { rows: collected.slice(0, EXPORT_ROW_CAP), truncated: true };
        }
      }
    });

    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="audit-log-${stamp}.csv"`)
      .header('x-export-rows', String(rows.length))
      .header('x-export-truncated', String(truncated))
      .send(eventsToCsv(rows));
  });
}
