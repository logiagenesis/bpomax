import { EVENT_OUTCOMES, isEventType, type EventOutcome, type EventType } from '@arbitron/core';
import { EVENTS_PAGE_LIMIT, listEvents, withUser } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from '../context.js';

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

/** ARB-014: the audit log viewer. */
export function registerEventRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/events', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });

    const query = request.query as EventQuery;

    let types: EventType[] | undefined;
    if (query.type !== undefined) {
      const requested = query.type.split(',').map((value) => value.trim());
      const unknown = requested.filter((value) => !isEventType(value));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: `unknown event type: ${unknown.join(', ')}` });
      }
      types = requested as EventType[];
    }

    if (query.outcome !== undefined && !EVENT_OUTCOMES.includes(query.outcome as EventOutcome)) {
      return reply.code(400).send({ error: `unknown outcome: ${query.outcome}` });
    }

    let from: string | undefined;
    let to: string | undefined;
    let limit: number | undefined;
    let offset: number | undefined;
    try {
      from = parseTimestamp(query.from, 'from');
      to = parseTimestamp(query.to, 'to');
      limit = parseCount(query.limit, 'limit');
      offset = parseCount(query.offset, 'offset');
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const events = await withUser(options.db, authUserId, (tx) =>
      listEvents(tx, {
        ...(types ? { type: types } : {}),
        ...(query.actor ? { actorUserId: query.actor } : {}),
        ...(query.subject_table ? { subjectTable: query.subject_table } : {}),
        ...(query.subject_id ? { subjectId: query.subject_id } : {}),
        ...(query.outcome ? { outcome: query.outcome as EventOutcome } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      }),
    );

    return reply.send({ events, page: { limit: limit ?? EVENTS_PAGE_LIMIT, offset: offset ?? 0 } });
  });
}
