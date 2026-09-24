/**
 * One row in every tenant-scoped table, for a given org.
 *
 * The same builder seeds an org and then attempts the cross-org write that must be
 * refused, so the denial test is never proving something narrower than the seed. For
 * the denial attempt `ref` stays on the victim org's existing parents (so a foreign key
 * cannot fail first and mask the real result) while `own` supplies fresh primary keys
 * and unique values (so a unique index cannot either).
 */
export interface FixtureRow {
  readonly table: string;
  readonly sql: string;
}

/** Deterministic, readable uuids: the tag identifies the owner, the number the entity. */
export function fixtureId(tag: string, n: number): string {
  return `${tag.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const ENTITY = {
  org: 1,
  user: 2,
  authUser: 3,
  membership: 4,
  platformAccount: 5,
  scanner: 6,
  job: 7,
  jobScore: 8,
  thread: 9,
  message: 10,
  discoverySession: 11,
  brief: 12,
  supplier: 13,
  rateCard: 14,
  sourcingRequest: 15,
  sourcingPost: 16,
  candidate: 17,
  estimate: 18,
  margin: 19,
  proposal: 20,
  pipelineItem: 21,
  deliveryOrder: 22,
  payment: 23,
  template: 24,
  templateVariant: 25,
  autoReply: 26,
  autoReplySend: 27,
  event: 28,
  settings: 29,
  subscription: 30,
  usageCounter: 31,
  affiliate: 32,
  attribution: 33,
  llmCall: 34,
  portfolioItem: 35,
  proposalCitation: 36,
  telegramLinkCode: 37,
  telegramPending: 38,
  connectAttempt: 39,
  billingCheckout: 40,
} as const;

export const CATEGORY_SLUG = 'web-design';

/** Global reference data: not tenant-scoped, seeded once. */
export const REFERENCE_ROWS: readonly FixtureRow[] = [
  {
    table: 'service_categories',
    sql: `insert into service_categories (slug, name, in_house) values ('${CATEGORY_SLUG}', 'Web design', true)`,
  },
  {
    table: 'market_price_bands',
    sql: `insert into market_price_bands (category_slug, currency, p25_minor, p50_minor, p75_minor, source)
          values ('${CATEGORY_SLUG}', 'ZAR', 150000, 300000, 600000, 'seed')`,
  },
];

/** The org row and the user who owns it. Neither table carries an org_id. */
export function identityRows(tag: string): readonly FixtureRow[] {
  const org = fixtureId(tag, ENTITY.org);
  const user = fixtureId(tag, ENTITY.user);
  const authUser = fixtureId(tag, ENTITY.authUser);
  return [
    {
      table: 'orgs',
      // A fixture org stands for the house org (0033's billing_exempt, D-069), so the
      // tests of every earlier ticket run unmetered; ARB-410's own tests unset it.
      sql: `insert into orgs (id, name, billing_exempt) values ('${org}', 'Org ${tag}', true)`,
    },
    {
      table: 'users',
      sql: `insert into users (id, auth_user_id, email, full_name, telegram_chat_id)
            values ('${user}', '${authUser}', '${tag}@example.test', 'User ${tag}', 'tg-${tag}')`,
    },
  ];
}

/**
 * One row per tenant-scoped table. `org` is the org the rows belong to, `ref` the tag
 * whose parent rows they point at, `own` the tag supplying their own keys.
 */
export function tenantRows(org: string, ref: string, own: string): readonly FixtureRow[] {
  const r = (n: number): string => fixtureId(ref, n);
  const o = (n: number): string => fixtureId(own, n);

  return [
    {
      table: 'memberships',
      sql: `insert into memberships (id, org_id, user_id, role)
            values ('${o(ENTITY.membership)}', '${org}', '${r(ENTITY.user)}', 'owner')`,
    },
    {
      table: 'platform_accounts',
      sql: `insert into platform_accounts (id, org_id, platform, external_user_id)
            values ('${o(ENTITY.platformAccount)}', '${org}', 'freelancer', 'ext-${own}')`,
    },
    {
      table: 'scanners',
      sql: `insert into scanners (id, org_id, name) values ('${o(ENTITY.scanner)}', '${org}', 'Scanner ${own}')`,
    },
    {
      table: 'jobs',
      sql: `insert into jobs (id, org_id, platform, external_id, raw, title, budget_min_minor, budget_max_minor, currency)
            values ('${o(ENTITY.job)}', '${org}', 'freelancer', 'job-${own}', '{}'::jsonb, 'A job', 100000, 200000, 'ZAR')`,
    },
    {
      table: 'job_scores',
      sql: `insert into job_scores (id, org_id, job_id, score, verdict, model)
            values ('${o(ENTITY.jobScore)}', '${org}', '${r(ENTITY.job)}', 70, 'go', 'claude-opus-5')`,
    },
    {
      table: 'threads',
      sql: `insert into threads (id, org_id, job_id, platform, external_thread_id)
            values ('${o(ENTITY.thread)}', '${org}', '${r(ENTITY.job)}', 'freelancer', 'thread-${own}')`,
    },
    {
      table: 'messages',
      sql: `insert into messages (id, org_id, thread_id, direction, body)
            values ('${o(ENTITY.message)}', '${org}', '${r(ENTITY.thread)}', 'in', 'Hello')`,
    },
    {
      table: 'discovery_sessions',
      sql: `insert into discovery_sessions (id, org_id, thread_id, question_set_version)
            values ('${o(ENTITY.discoverySession)}', '${org}', '${r(ENTITY.thread)}', 'v1-${own}')`,
    },
    {
      table: 'briefs',
      sql: `insert into briefs (id, org_id, thread_id, version, title, outcome)
            values ('${o(ENTITY.brief)}', '${org}', '${r(ENTITY.thread)}', ${own === ref ? 1 : 2}, 'Brief', 'An outcome')`,
    },
    {
      table: 'suppliers',
      sql: `insert into suppliers (id, org_id, name, channel)
            values ('${o(ENTITY.supplier)}', '${org}', 'Supplier ${own}', 'direct')`,
    },
    {
      table: 'supplier_rate_cards',
      sql: `insert into supplier_rate_cards (id, org_id, supplier_id, category_slug, currency, fixed_price_minor)
            values ('${o(ENTITY.rateCard)}', '${org}', '${r(ENTITY.supplier)}', '${CATEGORY_SLUG}', 'ZAR', 500000)`,
    },
    {
      table: 'sourcing_requests',
      sql: `insert into sourcing_requests (id, org_id, brief_id)
            values ('${o(ENTITY.sourcingRequest)}', '${org}', '${r(ENTITY.brief)}')`,
    },
    {
      table: 'sourcing_posts',
      sql: `insert into sourcing_posts (id, org_id, sourcing_request_id, platform, body)
            values ('${o(ENTITY.sourcingPost)}', '${org}', '${r(ENTITY.sourcingRequest)}', 'freelancer', 'Scope only')`,
    },
    {
      table: 'supplier_candidates',
      sql: `insert into supplier_candidates (id, org_id, sourcing_request_id, supplier_id, display_name)
            values ('${o(ENTITY.candidate)}', '${org}', '${r(ENTITY.sourcingRequest)}', '${r(ENTITY.supplier)}', 'Candidate ${own}')`,
    },
    {
      table: 'delivery_estimates',
      sql: `insert into delivery_estimates (id, org_id, job_id, category_slug, method, currency, low_minor, expected_minor, high_minor)
            values ('${o(ENTITY.estimate)}', '${org}', '${r(ENTITY.job)}', '${CATEGORY_SLUG}', 'rate_card', 'ZAR', 100000, 150000, 200000)`,
    },
    {
      table: 'margin_evaluations',
      sql: `insert into margin_evaluations (id, org_id, job_id, currency, client_budget_minor, platform_fee_minor,
              supplier_cost_minor, fx_buffer_minor, margin_minor, margin_pct, min_margin_pct, min_margin_zar_minor, passed)
            values ('${o(ENTITY.margin)}', '${org}', '${r(ENTITY.job)}', 'ZAR', 200000, 20000, 100000, 5000, 75000, 37.500, 30.000, 50000, true)`,
    },
    {
      table: 'proposals',
      sql: `insert into proposals (id, org_id, job_id, body, amount_minor, currency, delivery_days)
            values ('${o(ENTITY.proposal)}', '${org}', '${r(ENTITY.job)}', 'A proposal', 200000, 'ZAR', 7)`,
    },
    {
      table: 'pipeline_items',
      sql: `insert into pipeline_items (id, org_id, job_id)
            values ('${o(ENTITY.pipelineItem)}', '${org}', '${r(ENTITY.job)}')`,
    },
    {
      table: 'delivery_orders',
      sql: `insert into delivery_orders (id, org_id, pipeline_item_id)
            values ('${o(ENTITY.deliveryOrder)}', '${org}', '${r(ENTITY.pipelineItem)}')`,
    },
    {
      table: 'payments',
      sql: `insert into payments (id, org_id, pipeline_item_id, direction, kind, amount_minor, currency)
            values ('${o(ENTITY.payment)}', '${org}', '${r(ENTITY.pipelineItem)}', 'in', 'client', 200000, 'ZAR')`,
    },
    {
      table: 'templates',
      sql: `insert into templates (id, org_id, name) values ('${o(ENTITY.template)}', '${org}', 'Template ${own}')`,
    },
    {
      table: 'template_variants',
      sql: `insert into template_variants (id, org_id, template_id, label, body)
            values ('${o(ENTITY.templateVariant)}', '${org}', '${r(ENTITY.template)}', 'Variant ${own}', 'Body')`,
    },
    {
      table: 'auto_replies',
      sql: `insert into auto_replies (id, org_id, name, body)
            values ('${o(ENTITY.autoReply)}', '${org}', 'Auto ${own}', 'Body')`,
    },
    {
      table: 'auto_reply_sends',
      sql: `insert into auto_reply_sends (id, org_id, thread_id, auto_reply_id)
            values ('${o(ENTITY.autoReplySend)}', '${org}', '${r(ENTITY.thread)}', '${r(ENTITY.autoReply)}')`,
    },
    {
      table: 'events',
      sql: `insert into events (id, org_id, type) values ('${o(ENTITY.event)}', '${org}', 'test.${own}')`,
    },
    {
      table: 'settings',
      sql: `insert into settings (id, org_id) values ('${o(ENTITY.settings)}', '${org}')`,
    },
    {
      table: 'subscriptions',
      sql: `insert into subscriptions (id, org_id, plan) values ('${o(ENTITY.subscription)}', '${org}', 'starter')`,
    },
    {
      table: 'usage_counters',
      sql: `insert into usage_counters (id, org_id, metric, period_start)
            values ('${o(ENTITY.usageCounter)}', '${org}', 'bids-${own}', date '2026-09-01')`,
    },
    {
      table: 'affiliates',
      sql: `insert into affiliates (id, org_id, code) values ('${o(ENTITY.affiliate)}', '${org}', 'code-${own}')`,
    },
    {
      table: 'llm_calls',
      sql: `insert into llm_calls (id, org_id, purpose, model, input_tokens, output_tokens, cost_nano_usd)
            values ('${o(ENTITY.llmCall)}', '${org}', 'score', 'claude-opus-5', 1000, 200, 10000000)`,
    },
    {
      table: 'attribution',
      sql: `insert into attribution (id, org_id, affiliate_id, source)
            values ('${o(ENTITY.attribution)}', '${org}', '${r(ENTITY.affiliate)}', 'test')`,
    },
    {
      table: 'portfolio_items',
      sql: `insert into portfolio_items (id, org_id, title, kind, permission_to_show)
            values ('${o(ENTITY.portfolioItem)}', '${org}', 'Work ${own}', 'own_work', true)`,
    },
    {
      table: 'proposal_citations',
      sql: `insert into proposal_citations (id, org_id, proposal_id, portfolio_item_id)
            values ('${o(ENTITY.proposalCitation)}', '${org}', '${r(ENTITY.proposal)}', '${r(ENTITY.portfolioItem)}')`,
    },
    {
      table: 'telegram_link_codes',
      sql: `insert into telegram_link_codes (id, org_id, user_id, code, expires_at)
            values ('${o(ENTITY.telegramLinkCode)}', '${org}', '${r(ENTITY.user)}', 'code-${own}', now() + interval '10 minutes')`,
    },
    {
      table: 'platform_connect_attempts',
      sql: `insert into platform_connect_attempts (id, org_id, user_id, platform, expires_at)
            values ('${o(ENTITY.connectAttempt)}', '${org}', '${r(ENTITY.user)}', 'freelancer', now() + interval '10 minutes')`,
    },
    {
      table: 'billing_checkouts',
      sql: `insert into billing_checkouts (id, org_id, provider, plan_code, currency, reference)
            values ('${o(ENTITY.billingCheckout)}', '${org}', 'paystack', 'starter', 'ZAR', 'arb-${own}-${o(ENTITY.billingCheckout).slice(0, 8)}')`,
    },
    {
      table: 'telegram_pending',
      sql: `insert into telegram_pending (id, org_id, chat_id, action, proposal_id)
            values ('${o(ENTITY.telegramPending)}', '${org}', 'chat-${own}', 'edit', '${r(ENTITY.proposal)}')`,
    },
  ];
}

/** Every tenant-scoped table, in dependency order. */
export const TENANT_TABLES: readonly string[] = tenantRows('f', 'f', 'f').map((row) => row.table);
