import { ENTITY, REFERENCE_ROWS, fixtureId, identityRows } from '@arbitron/db/fixtures';
import { createTestDatabase } from '@arbitron/db/testing';
import type { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * ARB-320 acceptance: "Figures verified against raw SQL in tests". Real Postgres (PGlite)
 * with RLS on. The rows are the five jobs hand-worked in packages/core/src/analytics.test.ts,
 * built from the real tables; every figure the API gives is compared with a raw SQL query
 * over the base tables (not the view) and with the hand calculation.
 */
const ORG_A = fixtureId('a', ENTITY.org);
const ORG_B = fixtureId('b', ENTITY.org);
const AUTH_A = fixtureId('a', ENTITY.authUser);
const AUTH_B = fixtureId('b', ENTITY.authUser);
const USER_A = fixtureId('a', ENTITY.user);
const NOW = new Date('2026-09-23T10:00:00Z');
let db: PGlite;
let app: FastifyInstance;

const as = (authUser: string) => ({ 'x-test-auth-user': authUser });

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  return rows[0]!;
}

interface JobSpec {
  title: string;
  category: string | null;
  variant: string | null;
  scanner: string | null;
  replied?: 'after' | 'before';
  stage?: string;
  supplier?: string;
  inMinor?: number;
  outMinor?: number;
  unconverted?: boolean;
  costNano?: number;
}

async function makeJob(org: string, spec: JobSpec, submitted = true) {
  const job = await one<{ id: string }>(
    `insert into jobs (org_id, platform, external_id, raw, title, category_slug, scanner_id)
     values ($1, 'freelancer', $2, '{}'::jsonb, $2, $3, $4) returning id`,
    [org, spec.title, spec.category, spec.scanner],
  );
  const proposal = await one<{ id: string }>(
    `insert into proposals (org_id, job_id, body, amount_minor, currency, delivery_days, status,
                            approved_by, approved_via, submitted_at, template_variant_id)
     values ($1, $2, 'Bid', 100000, 'ZAR', 5, $3::proposal_status, $4, 'web', $5, $6) returning id`,
    [
      org,
      job.id,
      submitted ? 'submitted' : 'queued',
      org === ORG_A ? USER_A : fixtureId('b', ENTITY.user),
      submitted ? '2026-09-10T08:00:00Z' : null,
      spec.variant,
    ],
  );
  if (spec.replied) {
    const thread = await one<{ id: string }>(
      `insert into threads (org_id, job_id, platform, external_thread_id) values ($1, $2, 'freelancer', $3) returning id`,
      [org, job.id, `t-${spec.title}`],
    );
    await db.query(
      `insert into messages (org_id, thread_id, direction, body, sent_at, origin, external_message_id)
       values ($1, $2, 'in', 'Hello', $3, 'platform', $4)`,
      [
        org,
        thread.id,
        spec.replied === 'after' ? '2026-09-11T08:00:00Z' : '2026-09-09T08:00:00Z',
        `m-${spec.title}`,
      ],
    );
  }
  const item = await one<{ id: string }>(
    `insert into pipeline_items (org_id, job_id, stage) values ($1, $2, $3::pipeline_stage) returning id`,
    [org, job.id, spec.stage ?? 'applied'],
  );
  if (spec.supplier) {
    await db.query(
      `insert into delivery_orders (org_id, pipeline_item_id, supplier_id, status, agreed_cost_minor, currency, milestones)
       values ($1, $2, $3, 'accepted', 100, 'ZAR', '[{"title":"All","amountMinor":100,"due":null,"status":"accepted"}]'::jsonb)`,
      [org, item.id, spec.supplier],
    );
  }
  if (spec.inMinor)
    await db.query(
      `insert into payments (org_id, pipeline_item_id, direction, kind, amount_minor, currency, paid_at)
       values ($1, $2, 'in', 'client', $3, 'ZAR', '2026-09-20T08:00:00Z')`,
      [org, item.id, spec.inMinor],
    );
  if (spec.outMinor)
    await db.query(
      `insert into payments (org_id, pipeline_item_id, direction, kind, amount_minor, currency, paid_at)
       values ($1, $2, 'out', 'platform_fee', $3, 'ZAR', '2026-09-20T08:00:00Z')`,
      [org, item.id, spec.outMinor],
    );
  if (spec.unconverted)
    await db.query(
      `insert into payments (org_id, pipeline_item_id, direction, kind, amount_minor, currency, paid_at)
       values ($1, $2, 'in', 'client', 5000, 'USD', '2026-09-20T08:00:00Z')`,
      [org, item.id],
    );
  if (spec.costNano) {
    // Half on scoring the job, half on drafting the bid.
    await db.query(
      `insert into llm_calls (org_id, purpose, model, subject_table, subject_id, cost_nano_usd) values
         ($1, 'score', 'test-model', 'jobs', $2, $4), ($1, 'draft', 'test-model', 'proposals', $3, $4)`,
      [org, job.id, proposal.id, spec.costNano / 2],
    );
  }
  return job.id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  for (const row of REFERENCE_ROWS) await db.exec(row.sql);
  for (const row of [...identityRows('a'), ...identityRows('b')]) await db.exec(row.sql);
  await db.exec(`insert into memberships (org_id, user_id, role) values
    ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_B}', '${fixtureId('b', ENTITY.user)}', 'owner')`);
  await db.query(
    `insert into service_categories (slug, name, sort_order) values ('test-web', 'Web design', 90), ('test-seo', 'SEO', 91)`,
  );
  const scan = async (name: string) =>
    (
      await one<{ id: string }>(
        `insert into scanners (org_id, name) values ($1, $2) returning id`,
        [ORG_A, name],
      )
    ).id;
  const shopifyScan = await scan('Shopify scan');
  const seoScan = await scan('SEO scan');
  const variant = async (name: string) => {
    const t = await one<{ id: string }>(
      `insert into templates (org_id, name) values ($1, $2) returning id`,
      [ORG_A, name],
    );
    return (
      await one<{ id: string }>(
        `insert into template_variants (org_id, template_id, label, body) values ($1, $2, 'A', 'Body') returning id`,
        [ORG_A, t.id],
      )
    ).id;
  };
  const short = await variant('Short');
  const long = await variant('Long');
  const thandi = (
    await one<{ id: string }>(
      `insert into suppliers (org_id, name, channel) values ($1, 'Thandi', 'direct') returning id`,
      [ORG_A],
    )
  ).id;
  // The five jobs of the core test.
  await makeJob(ORG_A, {
    title: 'J1',
    category: 'test-web',
    variant: short,
    scanner: shopifyScan,
    replied: 'after',
    stage: 'paid',
    supplier: thandi,
    inMinor: 1_500_000,
    outMinor: 1_050_050,
    costNano: 3_000_000,
  });
  await makeJob(ORG_A, {
    title: 'J2',
    category: 'test-web',
    variant: short,
    scanner: shopifyScan,
    replied: 'after',
    stage: 'lost',
    costNano: 1_000_000,
  });
  await makeJob(ORG_A, {
    title: 'J3',
    category: 'test-web',
    variant: long,
    scanner: seoScan,
    costNano: 500_000,
  });
  await makeJob(ORG_A, {
    title: 'J4',
    category: null,
    variant: long,
    scanner: null,
    replied: 'after',
    unconverted: true,
    costNano: 250_000,
  });
  await makeJob(ORG_A, {
    title: 'J5',
    category: 'test-seo',
    variant: null,
    scanner: seoScan,
    stage: 'won',
    supplier: thandi,
    inMinor: 400_000,
    outMinor: 100_000,
  });
  // Not counted: a message before the bid is no reply; a bid never sent is no bid.
  await makeJob(ORG_A, {
    title: 'J6',
    category: 'test-seo',
    variant: null,
    scanner: null,
    replied: 'before',
  });
  await makeJob(
    ORG_A,
    { title: 'J7', category: 'test-seo', variant: null, scanner: null, replied: 'after' },
    false,
  );
  // Another organisation's bid: never in org A's figures.
  await makeJob(ORG_B, {
    title: 'B1',
    category: 'test-web',
    variant: null,
    scanner: null,
    replied: 'after',
  });

  app = buildServer({
    db,
    authenticate: (request) => {
      const header = request.headers['x-test-auth-user'];
      return typeof header === 'string' ? header : null;
    },
    now: () => NOW,
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.close();
});

const get = (query: string, who = AUTH_A) =>
  app.inject({ method: 'GET', url: `/v1/analytics${query}`, headers: as(who) });

/** Raw SQL over the base tables, not the view: bids, replies, won and lost per category. */
async function rawByCategory() {
  const { rows } = await db.query<{
    label: string;
    bids: string;
    replies: string;
    won: string;
    lost: string;
    margin: string;
    cost: string;
  }>(
    `select coalesce(c.name, 'Not classified') as label,
            count(*)::text as bids,
            count(*) filter (where exists (
              select 1 from threads t join messages m on m.thread_id = t.id
               where t.job_id = j.id and m.direction = 'in' and m.sent_at >= p.submitted_at))::text as replies,
            count(*) filter (where i.stage in ('won', 'in_delivery', 'delivered', 'paid'))::text as won,
            count(*) filter (where i.stage = 'lost')::text as lost,
            coalesce(sum((select sum(case when y.direction = 'in' then 1 else -1 end *
                                     case when y.currency = 'ZAR' then y.amount_minor else y.amount_zar_minor end)
                            from payments y where y.pipeline_item_id = i.id)), 0)::text as margin,
            coalesce(sum((select sum(l.cost_nano_usd) from llm_calls l
                           where (l.subject_table = 'jobs' and l.subject_id = j.id)
                              or (l.subject_table = 'proposals' and l.subject_id = p.id))), 0)::text as cost
       from jobs j
       join proposals p on p.job_id = j.id and p.status = 'submitted'
       left join service_categories c on c.slug = j.category_slug
       left join pipeline_items i on i.job_id = j.id
      where j.org_id = $1
      group by 1 order by 1`,
    [ORG_A],
  );
  return rows;
}

describe('analytics', () => {
  it('by category, each figure equals the raw SQL and the hand calculation', async () => {
    const res = await get('?by=category');
    expect(res.statusCode).toBe(200);
    const byLabel = Object.fromEntries(
      (res.json().rows as { label: string }[]).map((r) => [r.label, r]),
    );
    for (const raw of await rawByCategory()) {
      expect(byLabel[raw.label]).toMatchObject({
        bids: Number(raw.bids),
        replies: Number(raw.replies),
        won: Number(raw.won),
        lost: Number(raw.lost),
        realisedMarginZarMinor: raw.margin,
        modelCostNanoUsd: raw.cost,
      });
    }
    // By hand: Web design 3 bids, 2 replies (66,7 %), won 1 of 2 (50,0 %), R4 499,50,
    // USD 0,0045 of model, USD 0,00225 a reply. SEO counts J6's bid, but not its early message.
    expect(byLabel['Web design']).toMatchObject({
      bids: 3,
      replyRate: { percent: '66.7' },
      winRate: { percent: '50.0' },
      realisedMarginZarMinor: '449950',
      costPerReplyNanoUsd: '2250000',
    });
    expect(byLabel['SEO']).toMatchObject({ bids: 2, replies: 0, replyRate: { percent: '0.0' } });
    expect(byLabel['Not classified']).toMatchObject({ bids: 1, unconvertedPayments: 1 });
    // Six bids in all: J7 was never sent, and org B's is not org A's.
    expect(res.json().total).toMatchObject({ bids: 6, replies: 3, replyRate: { percent: '50.0' } });
  });

  it('by template, supplier and scanner', async () => {
    const template = (await get('?by=template')).json().rows as { label: string; bids: number }[];
    expect(template.map((r) => [r.label, r.bids])).toEqual([
      ['Long', 2],
      ['No template', 2],
      ['Short', 2],
    ]);
    const supplier = (await get('?by=supplier')).json().rows as {
      label: string;
      bids: number;
      realisedMarginZarMinor: string;
    }[];
    // Thandi: R4 499,50 + R3 000,00 = R7 499,50.
    expect(supplier.map((r) => [r.label, r.bids, r.realisedMarginZarMinor])).toEqual([
      ['No supplier', 4, '0'],
      ['Thandi', 2, '749950'],
    ]);
    const raw = await db.query<{ n: string }>(
      `select count(*)::text as n from delivery_orders o join pipeline_items i on i.id = o.pipeline_item_id
        where o.org_id = $1 and o.status <> 'cancelled' and o.supplier_id is not null`,
      [ORG_A],
    );
    expect(supplier.find((r) => r.label === 'Thandi')?.bids).toBe(Number(raw.rows[0]!.n));
    const scanner = (await get('?by=scanner')).json().rows as { label: string; bids: number }[];
    expect(scanner.map((r) => [r.label, r.bids])).toEqual([
      ['No scanner', 2],
      ['SEO scan', 2],
      ['Shopify scan', 2],
    ]);
  });

  it('a later start leaves earlier bids out; another organisation sees only its own; a bad dimension is refused', async () => {
    expect((await get('?by=category&since=2026-09-11')).json().total.bids).toBe(0);
    const other = await get('?by=category', AUTH_B);
    expect(other.json().total).toMatchObject({ bids: 1, replies: 1 });
    expect((await get('?by=colour')).statusCode).toBe(422);
    expect((await get('?since=11/09/2026')).statusCode).toBe(422);
  });
});
