import {
  canWrite,
  templateFigures,
  validateTemplateChange,
  validateVariantChange,
  variantFigures,
  variantWordsLocked,
  type TemplateChange,
  type VariantChange,
} from '@arbitron/core';
import { recordEvent, withUser, type Queryable } from '@arbitron/db';
import type { FastifyInstance } from 'fastify';
import {
  channelOf,
  currentMembership,
  invalid,
  UUID,
  type FieldProblem,
  type Membership,
  type ServerOptions,
} from '../context.js';
import { messageOf, rawMessage, refuse, statusOf } from '../errors.js';

/**
 * Bid templates and their A/B variants (ARB-340, docs/01 section I). Each variant's
 * sends and replies are read from `template_variant_stats` (migration 0030), counted
 * from the stored bids and messages when read; the rate is `variantFigures` in core.
 * Anyone in the organisation reads; an owner or operator creates and changes. A
 * variant's words are locked once a bid written from it has gone (D-064): its rate
 * measures those words.
 */
interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly category_slug: string | null;
  readonly category_name: string | null;
  readonly description: string | null;
  readonly active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

interface VariantRow {
  readonly id: string;
  readonly template_id: string;
  readonly label: string;
  readonly body: string;
  readonly active: boolean;
  readonly sends: number;
  readonly replies: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const VARIANT_SQL = `select v.id, v.template_id, v.label, v.body, v.active,
                            coalesce(s.sends, 0) as sends, coalesce(s.replies, 0) as replies,
                            v.created_at, v.updated_at
                       from template_variants v
                       left join template_variant_stats s on s.variant_id = v.id`;

function describeVariant(row: VariantRow) {
  return {
    id: row.id,
    label: row.label,
    body: row.body,
    active: row.active,
    ...variantFigures(row.sends, row.replies),
    wordsLocked: variantWordsLocked(row.sends),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function describeTemplate(row: TemplateRow, variants: readonly VariantRow[]) {
  const described = variants.map(describeVariant);
  const totals = templateFigures(described);
  return {
    id: row.id,
    name: row.name,
    categorySlug: row.category_slug,
    categoryName: row.category_name,
    description: row.description,
    active: row.active,
    variants: described,
    sends: totals.sends,
    replies: totals.replies,
    replyRate: totals.replyRate,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadTemplates(tx: Queryable, id?: string) {
  const { rows } = await tx.query<TemplateRow>(
    `select t.id, t.name, t.category_slug, c.name as category_name, t.description, t.active,
            t.created_at, t.updated_at
       from templates t
       left join service_categories c on c.slug = t.category_slug
      ${id ? 'where t.id = $1' : ''}
      order by t.active desc, c.sort_order nulls first, t.name`,
    id ? [id] : [],
  );
  const variants = await tx.query<VariantRow>(
    `${VARIANT_SQL} ${id ? 'where v.template_id = $1' : ''} order by v.active desc, v.label`,
    id ? [id] : [],
  );
  return rows.map((t) =>
    describeTemplate(
      t,
      variants.rows.filter((v) => v.template_id === t.id),
    ),
  );
}

async function writer(tx: Queryable): Promise<Membership> {
  const me = await currentMembership(tx);
  if (!me) throw refuse(403, 'you are not a member of an organisation');
  if (!canWrite(me.role)) throw refuse(403, 'your role can view templates but not change them');
  return me;
}

function fieldRefusal(errors: readonly FieldProblem[]): Error & { statusCode: number } {
  return Object.assign(refuse(422, 'the request was not accepted'), { errors });
}

async function checkCategory(tx: Queryable, change: TemplateChange): Promise<void> {
  if (!change.categorySlug) return;
  const { rows } = await tx.query('select 1 from service_categories where slug = $1', [
    change.categorySlug,
  ]);
  if (!rows[0])
    throw fieldRefusal([{ field: 'categorySlug', message: 'is not a service category' }]);
}

/** A unique collision as the field it is about, or the error as it was. */
function asFieldError(error: unknown): unknown {
  const message = rawMessage(error);
  if (/templates_org_id_name_key/.test(message))
    return fieldRefusal([{ field: 'name', message: 'is already used by another template' }]);
  if (/template_variants_template_id_label_key/.test(message))
    return fieldRefusal([{ field: 'label', message: 'is already used in this template' }]);
  return error;
}

function send(reply: { code(n: number): { send(body: unknown): unknown } }, error: unknown) {
  const e = asFieldError(error);
  const errors = (e as { errors?: unknown }).errors;
  if (Array.isArray(errors)) return reply.code(422).send(invalid(errors as FieldProblem[]));
  return reply.code(statusOf(e)).send({ error: messageOf(e) });
}

/** `set` clauses for the fields a change carries, numbered from `$2`. */
function setClauses(change: Record<string, unknown>, columns: Record<string, string>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (change[key] === undefined) continue;
    values.push(change[key]);
    sets.push(`${column} = $${String(values.length + 1)}`);
  }
  return { sets, values };
}

/** What changed, as `{ field: { from, to } }`, for the event. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (after[key] !== undefined && before[key] !== after[key])
      out[key] = { from: before[key], to: after[key] };
  }
  return out;
}

export function registerTemplateRoutes(app: FastifyInstance, options: ServerOptions): void {
  app.get('/v1/templates', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    try {
      const templates = await withUser(options.db, authUserId, async (tx) => {
        if (!(await currentMembership(tx)))
          throw refuse(403, 'you are not a member of an organisation');
        return loadTemplates(tx);
      });
      return reply.send({ templates });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post('/v1/templates', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const validated = validateTemplateChange(request.body, { partial: false });
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const change = validated.value;
    try {
      const template = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        await checkCategory(tx, change);
        const { rows } = await tx.query<{ id: string }>(
          `insert into templates (org_id, name, category_slug, description, active)
           values ($1, $2, $3, $4, $5) returning id`,
          [
            me.orgId,
            change.name,
            change.categorySlug ?? null,
            change.description ?? null,
            change.active ?? true,
          ],
        );
        const id = rows[0]!.id;
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'template.created',
          actorUserId: me.userId,
          subjectTable: 'templates',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: channelOf(request),
            name: change.name,
            category_slug: change.categorySlug ?? null,
          },
        });
        return (await loadTemplates(tx, id))[0]!;
      });
      return reply.code(201).send({ template });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.patch('/v1/templates/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateTemplateChange(request.body, { partial: true });
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const change = validated.value;
    try {
      const template = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const [before] = await loadTemplates(tx, id);
        if (!before) throw refuse(404, 'no such template');
        await checkCategory(tx, change);
        const { sets, values } = setClauses(change as Record<string, unknown>, {
          name: 'name',
          categorySlug: 'category_slug',
          description: 'description',
          active: 'active',
        });
        await tx.query(`update templates set ${sets.join(', ')} where id = $1`, [id, ...values]);
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'template.updated',
          actorUserId: me.userId,
          subjectTable: 'templates',
          subjectId: id,
          requestId: request.id,
          payload: {
            via: channelOf(request),
            changed: changedFields(before, change as Record<string, unknown>),
          },
        });
        return (await loadTemplates(tx, id))[0]!;
      });
      return reply.send({ template });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post('/v1/templates/:id/variants', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateVariantChange(request.body, { partial: false });
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const change: VariantChange = validated.value;
    try {
      const template = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const [before] = await loadTemplates(tx, id);
        if (!before) throw refuse(404, 'no such template');
        const { rows } = await tx.query<{ id: string }>(
          `insert into template_variants (org_id, template_id, label, body, active)
           values ($1, $2, $3, $4, $5) returning id`,
          [me.orgId, id, change.label, change.body, change.active ?? true],
        );
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'template.variant_created',
          actorUserId: me.userId,
          subjectTable: 'template_variants',
          subjectId: rows[0]!.id,
          requestId: request.id,
          payload: {
            via: channelOf(request),
            template_id: id,
            label: change.label,
            bodyLength: change.body!.length,
          },
        });
        return (await loadTemplates(tx, id))[0]!;
      });
      return reply.code(201).send({ template });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.patch('/v1/template-variants/:id', async (request, reply) => {
    const authUserId = await options.authenticate(request);
    if (!authUserId) return reply.code(401).send({ error: 'not signed in' });
    const { id } = request.params as { id: string };
    if (!UUID.test(id)) return reply.code(400).send({ error: 'id is not a uuid' });
    const validated = validateVariantChange(request.body, { partial: true });
    if (!validated.ok) return reply.code(422).send(invalid(validated.errors));
    const change = validated.value;
    try {
      const template = await withUser(options.db, authUserId, async (tx) => {
        const me = await writer(tx);
        const { rows } = await tx.query<VariantRow>(`${VARIANT_SQL} where v.id = $1`, [id]);
        const before = rows[0];
        if (!before) throw refuse(404, 'no such variant');
        if (change.body !== undefined && change.body !== before.body) {
          const locked = variantWordsLocked(before.sends);
          if (locked) throw refuse(409, locked);
        }
        const { sets, values } = setClauses(change as Record<string, unknown>, {
          label: 'label',
          body: 'body',
          active: 'active',
        });
        await tx.query(`update template_variants set ${sets.join(', ')} where id = $1`, [
          id,
          ...values,
        ]);
        const changed = changedFields(
          { label: before.label, body: before.body, active: before.active },
          change as Record<string, unknown>,
        );
        // The words themselves stay in the table; the log records that they changed.
        if (changed.body) changed.body = { from: before.body.length, to: change.body!.length };
        await recordEvent(tx, {
          orgId: me.orgId,
          type: 'template.variant_updated',
          actorUserId: me.userId,
          subjectTable: 'template_variants',
          subjectId: id,
          requestId: request.id,
          payload: { via: channelOf(request), template_id: before.template_id, changed },
        });
        return (await loadTemplates(tx, before.template_id))[0]!;
      });
      return reply.send({ template });
    } catch (error) {
      return send(reply, error);
    }
  });
}
