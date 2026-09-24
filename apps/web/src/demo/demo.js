// @ts-check
/**
 * Demo mode (D-043). Only a demo build contains this file: `vite build --mode demo`
 * injects it ahead of every page's own script (apps/web/vite.config.js), and every other
 * build leaves it out, so a real deployment can never fall back to it (D-036).
 *
 * It stands in for the two services a page talks to, inside the browser:
 * - Supabase Auth: any email and password signs in, as a sample person.
 * - The Arbitron API: every route the pages call, answered in the shapes the real routes
 *   return (the same shapes the Playwright specs use), from sample data kept in this
 *   tab's sessionStorage. The rules a form is held to are `@arbitron/core`'s, the same
 *   ones the API runs, so the demo accepts and refuses what the real thing would.
 *
 * Nothing leaves the browser. Every page carries a banner saying so, and saying that the
 * figures are samples, not real prices, fees or clients.
 */
import {
  DISCOVERY_QUESTIONS,
  briefFromDiscovery,
  buildSourcingPost,
  clientIdentifyingProblems,
  validateSourcingPostEdit,
  briefLockBlockers,
  checkAutoSendGuardrails,
  discoveryCompleteness,
  liveModeBlockers,
  nextDiscoveryBatch,
  ANALYTICS_DIMENSIONS,
  DELIVERY_TRANSITIONS,
  PIPELINE_STAGES,
  aggregateAnalytics,
  analyticsTotal,
  clientPaidInFull,
  directionOf,
  realisedMargin,
  sastDay,
  validatePaymentInput,
  zarOf,
  evaluateMargin,
  feeOn,
  findFeeRule,
  handoverChecklist,
  milestoneTotal,
  onboardingSteps,
  pipelineStageFor,
  reconcileMilestones,
  transitionBlockers,
  validateDeliveryOrderEdit,
  validateRetainer,
  parseFeeTable,
  rankSuppliers,
  renderDiscoveryBatch,
  validateAutoReply,
  validateBrief,
  validateDiscoveryAnswers,
  validateMarginRules,
  validateMessageDraft,
  validatePlanRecord,
  validateScanner,
  supplierCsvTemplate,
  suppliersToCsv,
  validateSupplierCsv,
  templateFigures,
  validateTemplateChange,
  validateVariantChange,
  variantFigures,
  variantWordsLocked,
} from '@arbitron/core';

const env = /** @type {Record<string, string | undefined>} */ (import.meta.env ?? {});
const API_ORIGIN = new URL(env.VITE_API_URL || 'https://demo-api.invalid').origin;
const AUTH_ORIGIN = new URL(env.VITE_SUPABASE_URL || 'https://demo.supabase.invalid').origin;
const STORE_KEY = 'arbitron.demo';
const SESSION_KEY = 'arbitron.session';

/** @typedef {Record<string, any>} Row */
/**
 * @typedef {{ version: number, telegramLinked: boolean, biddingPaused: boolean,
 *   settings: Row, accounts: Row[], scanners: Row[], jobs: Row[], proposals: Row[],
 *   events: Row[], connectPending?: boolean, autoReply?: Row | null, outbound?: Row[],
 *   threads?: Row[], inbound?: Row[], discovery?: Row[], briefs?: Row[], suppliers?: Row[],
 *   sourcing?: Row[], posts?: Row[], pipeline?: Row[], orders?: Row[], payments?: Row[],
 *   templates?: Row[], upworkConnectPending?: boolean }} Store
 */

const ORG = 'd0d0d0d0-0000-4000-8000-000000000001';
const USER = 'd0d0d0d0-0000-4000-8000-000000000002';

/**
 * Days before now, as an ISO string.
 * @param {number} days
 * @param {number} [hours]
 */
function ago(days, hours = 0) {
  return new Date(Date.now() - (days * 24 + hours) * 3_600_000).toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

// --------------------------------------------------------------------- sample data
/** @param {string} title @param {Row} partial @returns {Row} */
function job(title, partial) {
  return {
    id: uuid(),
    platform: 'freelancer',
    external_id: String(Math.floor(Math.random() * 9_000_000) + 1_000_000),
    title,
    currency: 'ZAR',
    budget_min_minor: '500000',
    budget_max_minor: '1200000',
    hourly: false,
    client_country: 'ZA',
    client_payment_verified: true,
    bid_count: 6,
    posted_at: ago(0, 5),
    first_seen_at: ago(0, 4),
    category_slug: 'website-build',
    score: null,
    verdict: null,
    flags: null,
    estimate_expected_minor: null,
    estimate_currency: null,
    estimate_method: null,
    margin_id: null,
    margin_minor: null,
    margin_pct: null,
    margin_currency: null,
    margin_passed: null,
    margin_reason: null,
    proposal_id: null,
    proposal_status: null,
    ...partial,
  };
}

/** @param {Row} j @param {Row} partial @returns {Row} */
function proposalFor(j, partial) {
  return {
    id: uuid(),
    job_id: j.id,
    job_title: j.title,
    platform: 'freelancer',
    status: 'queued',
    body: `Hello,\n\nThis is a sample bid written for the demo. We would deliver "${j.title}" in milestones, with a check-in at each one.\n\nKind regards`,
    amount_minor: j.budget_max_minor ?? '800000',
    currency: j.currency ?? 'ZAR',
    delivery_days: 10,
    milestones: [{ title: 'Design' }, { title: 'Build' }, { title: 'Launch' }],
    approved_by: null,
    approved_by_name: null,
    approved_via: null,
    submitted_at: null,
    failure_reason: null,
    created_at: ago(0, 3),
    updated_at: ago(0, 3),
    score: j.score,
    verdict: j.verdict,
    estimate_expected_minor: j.estimate_expected_minor,
    estimate_currency: j.estimate_currency,
    estimate_method: j.estimate_method,
    margin_minor: j.margin_minor,
    margin_pct: j.margin_pct,
    margin_currency: j.margin_currency,
    fx_rate_used: null,
    fx_rate_at: null,
    ...partial,
  };
}

/** @param {string} type @param {Row} [partial] @returns {Row} */
function event(type, partial = {}) {
  return {
    id: uuid(),
    org_id: ORG,
    actor_user_id: null,
    actor_kind: 'system',
    type,
    subject_table: null,
    subject_id: null,
    request_id: null,
    outcome: 'ok',
    payload: {},
    created_at: new Date().toISOString(),
    ...partial,
  };
}

/** @returns {Store} */
function initialStore() {
  const shop = job('Shopify store rebuild (sample)', {
    score: 82,
    verdict: 'go',
    category_slug: 'shopify',
    estimate_expected_minor: '600000',
    estimate_currency: 'ZAR',
    estimate_method: 'rate_card',
    margin_id: uuid(),
    margin_minor: '350000',
    margin_pct: '36.842',
    margin_currency: 'ZAR',
    margin_passed: true,
  });
  const landing = job('Landing page for a product launch (sample)', {
    score: 64,
    verdict: 'caution',
    category_slug: 'landing-page',
    currency: 'USD',
    budget_min_minor: '30000',
    budget_max_minor: '50000',
    client_country: 'GB',
    client_payment_verified: false,
    flags: ['unverified_payment'],
    estimate_expected_minor: '25000',
    estimate_currency: 'USD',
    estimate_method: 'in_house',
    margin_id: uuid(),
    margin_minor: '18000',
    margin_pct: '36.000',
    margin_currency: 'USD',
    margin_passed: true,
  });
  const wp = job('WordPress site speed fixes (sample)', {
    score: 71,
    verdict: 'go',
    category_slug: 'wordpress',
    budget_min_minor: '200000',
    budget_max_minor: '400000',
    estimate_expected_minor: '350000',
    estimate_currency: 'ZAR',
    estimate_method: 'rate_card',
    margin_id: uuid(),
    margin_minor: '20000',
    margin_pct: '5.000',
    margin_currency: 'ZAR',
    margin_passed: false,
    margin_reason: 'margin 5,0% is below the minimum (sample rule)',
  });
  const scam = job('Pay a registration fee to see the brief (sample)', {
    score: 4,
    verdict: 'skip',
    category_slug: 'data-entry',
    client_payment_verified: false,
    flags: ['upfront_fee'],
    client_country: null,
  });
  const fresh = job('Mobile app prototype (sample)', {
    category_slug: 'mobile-app',
    budget_min_minor: null,
    budget_max_minor: null,
    currency: null,
    bid_count: null,
  });
  const bidShop = proposalFor(shop, {});
  const bidLanding = proposalFor(landing, {
    amount_minor: '50000',
    currency: 'USD',
    fx_rate_used: '18.00000000',
    fx_rate_at: ago(0, 6),
  });
  const sent = proposalFor(wp, {
    status: 'submitted',
    approved_by: USER,
    approved_by_name: 'Demo Owner',
    approved_via: 'telegram',
    submitted_at: ago(2),
  });
  shop.proposal_id = bidShop.id;
  shop.proposal_status = 'queued';
  landing.proposal_id = bidLanding.id;
  landing.proposal_status = 'queued';

  // ARB-140: two sample conversations. The first is mid-discovery with a reply waiting;
  // the second has no messages yet.
  const THREAD_ACME = 'd0d0d0d0-0000-4000-8000-000000000041';
  const THREAD_QUIET = 'd0d0d0d0-0000-4000-8000-000000000042';
  const threads = [
    {
      id: THREAD_ACME,
      platform: 'freelancer',
      externalThreadId: '5001',
      jobId: shop.id,
      jobTitle: shop.title,
      clientHandle: 'acme-shop (sample)',
      status: 'awaiting_operator',
      createdAt: ago(1),
    },
    {
      id: THREAD_QUIET,
      platform: 'freelancer',
      externalThreadId: '5002',
      jobId: landing.id,
      jobTitle: landing.title,
      clientHandle: 'quiet-client (sample)',
      status: 'open',
      createdAt: ago(0, 6),
    },
  ];
  const inbound = [
    {
      id: uuid(),
      threadId: THREAD_ACME,
      direction: 'out',
      origin: 'platform',
      body: 'Hello, thank you for reading our bid. Happy to answer any question. (sample)',
      state: 'observed',
      sentAt: ago(1),
      createdAt: ago(1),
    },
    {
      id: uuid(),
      threadId: THREAD_ACME,
      direction: 'in',
      origin: 'platform',
      body: 'Hi, can you start on Monday? (sample)',
      state: 'received',
      sentAt: ago(0, 2),
      createdAt: ago(0, 2),
    },
  ];
  const discovery = [
    {
      id: uuid(),
      threadId: THREAD_ACME,
      version: '1',
      answers: {
        outcome: {
          answer: 'An online shop for our customers (sample)',
          source: 'client',
          capturedAt: ago(0, 2),
        },
        users: {
          answer: 'Our customers and two staff (sample)',
          source: 'operator',
          capturedAt: ago(0, 1),
        },
        day_one: {
          answer: 'Take orders; loyalty can wait (sample)',
          source: 'client',
          capturedAt: ago(0, 2),
        },
      },
      asked: { outcome: ago(1), users: ago(1), day_one: ago(1) },
      createdAt: ago(1),
      updatedAt: ago(0, 1),
    },
  ];

  // ARB-200: two sample suppliers with rate cards, marked as samples; nothing is a real rate.
  const suppliers = [
    {
      id: uuid(),
      name: 'Thandi Web (sample)',
      countryCode: 'ZA',
      timeZone: 'Africa/Johannesburg',
      channel: 'direct',
      languages: ['en', 'zu'],
      qualityScore: '85.00',
      onTimeRate: '0.950',
      paysAfterDelivery: true,
      externalProfileUrl: null,
      notes: 'Sample supplier; no real rate.',
      active: true,
      rateCards: [
        {
          id: uuid(),
          categorySlug: 'wordpress',
          categoryName: 'Wordpress',
          currency: 'ZAR',
          fixedPriceMinor: '150000',
          hourlyRateMinor: null,
          turnaroundDays: 5,
        },
        {
          id: uuid(),
          categorySlug: 'seo',
          categoryName: 'Seo',
          currency: 'ZAR',
          fixedPriceMinor: null,
          hourlyRateMinor: '35050',
          turnaroundDays: null,
        },
      ],
      createdAt: ago(3),
      updatedAt: ago(3),
    },
    {
      id: uuid(),
      name: 'Studio Nord (sample)',
      countryCode: 'NO',
      timeZone: 'Europe/Oslo',
      channel: 'upwork',
      languages: ['en'],
      qualityScore: null,
      onTimeRate: null,
      paysAfterDelivery: false,
      externalProfileUrl: null,
      notes: null,
      active: false,
      rateCards: [],
      createdAt: ago(2),
      updatedAt: ago(2),
    },
  ];

  // ARB-201: the sample conversation's brief is locked and sourced; the ranking is the
  // real rule over the sample suppliers, so the reasons on the page are the real ones.
  const deadline = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  const lockedBrief = {
    id: 'd0d0d0d0-0000-4000-8000-000000000061',
    threadId: THREAD_ACME,
    version: 1,
    locked: true,
    lockedAt: ago(0, 1),
    title: 'Shopify store rebuild (sample)',
    outcome: 'An online shop for our customers (sample)',
    users: 'Our customers and two staff (sample)',
    mustHaves: ['Take orders'],
    later: ['Loyalty'],
    references: [],
    assetsProvided: [],
    assetsMissing: [],
    techConstraints: [],
    deadline,
    deadlineFixed: false,
    budget: {
      minMinor: 1000000,
      maxMinor: 2000000,
      currency: 'ZAR',
      type: /** @type {'fixed'} */ ('fixed'),
    },
    acceptanceCriteria: ['Orders go through'],
    signOff: { name: null, responseTime: null },
    risks: [],
    category: 'wordpress',
    deliveryRoute: 'supplier',
    createdAt: ago(0, 2),
    updatedAt: ago(0, 1),
  };
  const sampleRanking = rankSuppliers(
    {
      category: 'wordpress',
      budget: lockedBrief.budget,
      deadline,
      deadlineFixed: false,
    },
    /** @type {any} */ (
      suppliers.map((sup) => ({
        ...sup,
        rateCards: sup.rateCards.filter((/** @type {Row} */ c) => c.categorySlug === 'wordpress'),
      }))
    ),
    { now: new Date() },
  );
  const sourcing = [
    {
      id: 'd0d0d0d0-0000-4000-8000-000000000071',
      briefId: lockedBrief.id,
      briefVersion: 1,
      briefTitle: lockedBrief.title,
      category: 'wordpress',
      deliveryRoute: 'supplier',
      threadId: THREAD_ACME,
      clientHandle: 'acme-shop (sample)',
      jobTitle: shop.title,
      channels: [...new Set(sampleRanking.ranked.map((r) => r.channel))],
      status: 'open',
      excluded: sampleRanking.excluded,
      candidates: sampleRanking.ranked.map((r) => ({
        id: uuid(),
        supplierId: r.supplierId,
        name: r.name,
        channel: r.channel,
        countryCode: r.countryCode,
        timeZone: r.timeZone,
        currency: r.currency,
        quotedPriceMinor: r.quotedPriceMinor,
        priced: r.priced,
        turnaroundDays: r.turnaroundDays,
        score: r.score,
        parts: r.parts,
        reasons: r.reasons,
        shortlisted: false,
      })),
      createdAt: ago(0, 1),
      updatedAt: ago(0, 1),
    },
  ];

  // ARB-310: the pipeline. The sample shop job is won, so a supplier can be chosen for it.
  const pipeline = [
    {
      id: 'd0d0d0d0-0000-4000-8000-000000000091',
      jobId: shop.id,
      jobTitle: shop.title,
      platform: 'freelancer',
      stage: 'won',
      valueMinor: '1200000',
      currency: 'ZAR',
      retainer: false,
      retainerMonthlyMinor: null,
      stageChangedAt: ago(0, 3),
    },
    {
      id: 'd0d0d0d0-0000-4000-8000-000000000093',
      jobId: 'd0d0d0d0-0000-4000-8000-000000000094',
      jobTitle: 'Monthly site care (sample)',
      platform: 'freelancer',
      stage: 'paid',
      valueMinor: '450000',
      currency: 'ZAR',
      retainer: true,
      retainerMonthlyMinor: '450000',
      stageChangedAt: ago(20),
    },
    {
      id: 'd0d0d0d0-0000-4000-8000-000000000092',
      jobId: wp.id,
      jobTitle: wp.title,
      platform: 'freelancer',
      stage: 'applied',
      valueMinor: sent.amount_minor,
      currency: sent.currency,
      retainer: false,
      retainerMonthlyMinor: null,
      stageChangedAt: ago(2),
    },
  ];

  return {
    version: 1,
    threads,
    inbound,
    discovery,
    briefs: [lockedBrief],
    suppliers,
    sourcing,
    pipeline,
    orders: [],
    telegramLinked: false,
    biddingPaused: false,
    settings: {
      minMarginPct: null,
      minMarginZarMinor: null,
      fxBufferPct: null,
      vatPct: '15.000',
      retentionDays: null,
      feeTable: [],
      liveMode: false,
      biddingPaused: false,
      updatedAt: null,
    },
    accounts: [
      {
        id: uuid(),
        platform: 'freelancer',
        externalUserId: 'sample-account',
        status: 'connected',
        scopes: [],
        lastSyncAt: null,
        planName: null,
        monthlyBidAllowance: null,
        planRecordedOn: null,
      },
    ],
    scanners: [
      {
        id: uuid(),
        org_id: ORG,
        name: 'ZA web builds (sample)',
        platform: 'freelancer',
        filters: { keywords: ['wordpress', 'shopify', 'website'] },
        poll_interval_seconds: 300,
        active: true,
        auto_send: false,
        min_score: null,
        daily_cap: 0,
        created_at: ago(3),
        updated_at: ago(3),
      },
    ],
    jobs: [shop, landing, wp, scam, fresh],
    proposals: [bidShop, bidLanding, sent],
    // ARB-122: one reply waiting for approval, drafted for the sample client's message.
    outbound: [
      {
        id: 'd0d0d0d0-0000-4000-8000-000000000040',
        threadId: 'd0d0d0d0-0000-4000-8000-000000000041',
        externalThreadId: '5001',
        clientHandle: 'acme-shop (sample)',
        jobId: bidShop.job_id,
        jobTitle: bidShop.job_title,
        body: 'Thanks for your message. Yes, we can start on Monday, and I will send a short plan today. (sample)',
        state: 'queued',
        approvedBy: null,
        approvedByName: null,
        approvedVia: null,
        sentAt: null,
        rejectedAt: null,
        failureReason: null,
        externalMessageId: null,
        createdAt: ago(0, 1),
        updatedAt: ago(0, 1),
        lastInbound: { body: 'Hi, can you start on Monday? (sample)', sentAt: ago(0, 2) },
      },
    ],
    events: [
      event('proposal.submitted', {
        created_at: ago(2),
        actor_kind: 'system',
        subject_table: 'proposals',
        subject_id: sent.id,
      }),
      event('proposal.approved', {
        created_at: ago(2, 1),
        actor_kind: 'user',
        actor_user_id: USER,
        subject_table: 'proposals',
        subject_id: sent.id,
        payload: { via: 'telegram' },
      }),
      event('external.blocked_by_live_mode', {
        created_at: ago(1),
        outcome: 'blocked',
        payload: { endpoint: 'POST /projects/0.1/bids/', note: 'sample' },
      }),
      event('scanner.created', {
        created_at: ago(3),
        actor_kind: 'user',
        actor_user_id: USER,
        subject_table: 'scanners',
        payload: { name: 'ZA web builds (sample)' },
      }),
      event('job.scored', { created_at: ago(0, 4), subject_table: 'jobs', subject_id: shop.id }),
      event('job.ingested', { created_at: ago(0, 5), subject_table: 'jobs', subject_id: shop.id }),
    ],
  };
}

/** @returns {Store} */
function load() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* start again */
  }
  const store = initialStore();
  save(store);
  return store;
}

/** @param {Store} store */
function save(store) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* the demo still works for this page */
  }
}

// ----------------------------------------------------------------- responses
/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function json(status, body, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const DEMO_CATEGORIES = [
  'website-build',
  'wordpress',
  'elementor',
  'shopify',
  'landing-page',
  'web-app',
  'mobile-app',
  'api-integration',
  'automation',
  'ai-chatbot',
  'seo',
  'google-ads',
  'social-media-management',
  'logo-brand',
  'graphic-design',
  'ui-ux',
  'video-editing',
  'copywriting',
  'data-entry',
  'virtual-assistant',
  '2d-game',
  '3d-game',
];

/** @param {string} slug */
function categoryName(slug) {
  return slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** A CSV file as the API serves one, with the headers the page reads. @param {string} body @param {string} filename @param {number | null} rows */
function csvFile(body, filename, rows) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      ...(rows === null ? {} : { 'x-export-rows': String(rows), 'x-export-truncated': 'false' }),
    },
  });
}

/** @param {Store} store */
function me(store) {
  return {
    user: {
      id: USER,
      email: 'demo@example.com',
      fullName: 'Demo Owner',
      telegramLinked: store.telegramLinked,
    },
    org: { id: ORG, name: 'Logi-Ink (demo)', baseCurrency: 'ZAR' },
    role: 'owner',
  };
}

/** @param {Row} settings */
function blockersOf(settings) {
  return liveModeBlockers({
    minMarginPct: settings.minMarginPct,
    minMarginZarMinor: settings.minMarginZarMinor,
    fxBufferPct: settings.fxBufferPct,
    feeTableLength: settings.feeTable.length,
    retentionDays: settings.retentionDays,
  });
}

/** @param {Store} store @param {string} type @param {Row} [partial] */
function logEvent(store, type, partial = {}) {
  store.events.unshift(
    event(type, { actor_kind: 'user', actor_user_id: USER, payload: { via: 'web' }, ...partial }),
  );
}

/**
 * Whether a sent bid had a client message on its job's conversation at or after it went:
 * the reply rule of analytics and templates (D-061, D-064).
 * @param {Store} store @param {Row} p
 */
function repliedAfter(store, p) {
  const t = (store.threads ?? []).find((x) => x.jobId === p.job_id);
  return (store.inbound ?? []).some(
    (m) =>
      t &&
      m.threadId === t.id &&
      new Date(m.sentAt ?? m.createdAt ?? 0).getTime() >= new Date(p.submitted_at).getTime(),
  );
}

/**
 * ARB-340 in the demo: one sample template with two variants, the tab's sent bid written
 * from the first. Made the first time a page asks, so a tab opened before it still works.
 * @param {Store} store
 */
function templatesOf(store) {
  if (!store.templates) {
    const made = ago(5);
    const variant = (/** @type {string} */ label, /** @type {string} */ body) => ({
      id: uuid(),
      label,
      body,
      active: true,
      createdAt: made,
      updatedAt: made,
    });
    const a = variant(
      'A',
      'Open with the outcome the client asked for, then the plan in three steps. (sample words)',
    );
    const b = variant(
      'B',
      'Open with one question about their goal, then the plan in three steps. (sample words)',
    );
    store.templates = [
      {
        id: uuid(),
        name: 'Website builds (sample)',
        categorySlug: 'website-build',
        description: 'Sample words. Replace them with your own.',
        active: true,
        variants: [a, b],
        createdAt: made,
        updatedAt: made,
      },
    ];
    const sent = store.proposals.find((p) => p.status === 'submitted' && !p.template_variant_id);
    if (sent) sent.template_variant_id = a.id;
  }
  return store.templates;
}

/** A template as `GET /v1/templates` gives it. @param {Store} store @param {Row} t */
function templateView(store, t) {
  const variants = t.variants.map((/** @type {Row} */ v) => {
    const sent = store.proposals.filter(
      (p) => p.template_variant_id === v.id && p.status === 'submitted' && p.submitted_at,
    );
    const replies = sent.filter((p) => repliedAfter(store, p)).length;
    return {
      id: v.id,
      label: v.label,
      body: v.body,
      active: v.active,
      ...variantFigures(sent.length, replies),
      wordsLocked: variantWordsLocked(sent.length),
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    };
  });
  const totals = templateFigures(variants);
  return {
    id: t.id,
    name: t.name,
    categorySlug: t.categorySlug,
    categoryName: t.categorySlug ? categoryName(t.categorySlug) : null,
    description: t.description,
    active: t.active,
    variants,
    sends: totals.sends,
    replies: totals.replies,
    replyRate: totals.replyRate,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * ARB-204 in the demo: what the reprice worker would record for a candidate's quote,
 * worked in the tab by core's margin engine with the tab's rules. A missing rule blocks
 * and is named, as it is on the server (D-029); the demo has no FX provider, so a deal
 * that needs a rate blocks as B-10 does.
 * @param {Row} settings @param {Row} j @param {Row} c
 * @returns {{ margin: Row | null, reprice: Row }}
 */
function demoReprice(settings, j, c) {
  const at = new Date().toISOString();
  const kept = c.margin ?? null;
  /** @param {string} reason @param {string[]} detail */
  const blocked = (reason, detail) => ({
    margin: kept,
    reprice: { outcome: 'blocked', reason, message: null, detail, at },
  });
  const budget = j.budget_max_minor ?? j.budget_min_minor;
  if (budget === null || !j.currency) {
    return {
      margin: kept,
      reprice: {
        outcome: 'skipped',
        reason: 'no_budget',
        message: 'The job states no budget, so no margin can be worked out.',
        detail: [],
        at,
      },
    };
  }
  if (c.currency !== j.currency) {
    return blocked('currency_mismatch', [
      `the estimate is in ${String(c.currency)} but the job is in ${String(j.currency)}`,
    ]);
  }
  const missing = [];
  if (settings.minMarginPct === null) missing.push('min_margin_pct (docs/02 D-02)');
  if (settings.minMarginZarMinor === null) missing.push('min_margin_zar_minor (docs/02 D-02)');
  if (settings.fxBufferPct === null) missing.push('fx_buffer_pct (docs/02 D-03)');
  if (!Array.isArray(settings.feeTable) || settings.feeTable.length === 0) {
    missing.push('fee_table (docs/02 T-02)');
  }
  if (missing.length > 0) return blocked('rules_missing', missing);
  const table = parseFeeTable(settings.feeTable);
  if (!table.ok) {
    return blocked(
      'fee_table_invalid',
      table.errors.map((e) => `fee_table${e.field} ${e.message}`),
    );
  }
  const projectType = j.hourly ? 'hourly' : 'fixed';
  const fee = findFeeRule(table.value, 'freelancer', projectType, 'freelancer');
  if (!fee) {
    return blocked('fee_rule_missing', [
      `no fee rule for freelancer ${projectType} projects on the freelancer side (docs/02 T-02)`,
    ]);
  }
  if (j.currency !== 'ZAR' || (fee.minCurrency !== null && fee.minCurrency !== j.currency)) {
    return blocked('fx_unavailable', ['the demo has no FX provider (docs/02 B-10)']);
  }
  // A bid on our own Freelancer.com project also pays the employer's fee, as on the server.
  let cost = Number(c.quotedPriceMinor);
  if (c.source === 'bid') {
    const employer = findFeeRule(table.value, 'freelancer', 'fixed', 'employer');
    if (!employer) {
      return blocked('fee_rule_missing', [
        'no fee rule for freelancer fixed projects on the employer side, which a bid on our own project pays (docs/02 T-02)',
      ]);
    }
    if (employer.minCurrency !== null && employer.minCurrency !== j.currency) {
      return blocked('fx_unavailable', ['the demo has no FX provider (docs/02 B-10)']);
    }
    cost += feeOn(cost, employer, employer.minMinor).feeMinor;
  }
  const e = evaluateMargin({
    currency: j.currency,
    hourly: Boolean(j.hourly),
    clientBudgetMinor: Number(budget),
    supplierCostMinor: cost,
    toolCostMinor: 0,
    fee,
    feeMinimumMinor: fee.minMinor,
    fxBufferPercent: Number(settings.fxBufferPct),
    minMarginPercent: Number(settings.minMarginPct),
    minMarginHomeMinor: Number(settings.minMarginZarMinor),
    fxToHome: null,
  });
  return {
    margin: {
      evaluationId: uuid(),
      currency: e.currency,
      marginMinor: String(e.marginMinor),
      marginPct: e.marginPercent,
      passed: e.passed,
      reason: e.reason,
      at,
    },
    reprice: { outcome: 'ok', reason: null, message: null, detail: [], at },
  };
}

/** @param {string} date */
function sast(date) {
  const d = new Date(new Date(date).getTime() + 2 * 3_600_000);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** @param {unknown} value */
function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {Store} store @param {URL} url @returns {Row[]} */
function filteredEvents(store, url) {
  const type = url.searchParams.get('type');
  const actor = url.searchParams.get('actor');
  const outcome = url.searchParams.get('outcome');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  return store.events.filter(
    (e) =>
      (!type || type.split(',').includes(e.type)) &&
      (!actor || e.actor_user_id === actor) &&
      (!outcome || e.outcome === outcome) &&
      (!from || e.created_at >= from) &&
      (!to || e.created_at < to),
  );
}

function monthStart() {
  const now = new Date(Date.now() + 2 * 3_600_000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 2 * 3_600_000);
}

/**
 * @param {string} method
 * @param {URL} url
 * @param {any} body
 */
function api(method, url, body) {
  const store = load();
  const path = url.pathname;
  const key = `${method} ${path}`;
  const idIn = (/** @type {string} */ prefix) => path.slice(prefix.length).split('/')[0];

  /** @param {number} status @param {unknown} payload @param {Record<string, string>} [headers] */
  const respond = (status, payload, headers) => {
    save(store);
    return json(status, payload, headers);
  };

  if (key === 'GET /v1/me') return respond(200, me(store));
  // ARB-400 in the demo: the sample person already owns the sample org, so onboarding
  // shows the steps, each read from the tab's own sample rows.
  if (key === 'GET /v1/onboarding') {
    const settings = store.settings;
    return respond(200, {
      ...me(store),
      steps: onboardingSteps({
        marginRulesSet:
          settings.minMarginPct !== null &&
          settings.minMarginZarMinor !== null &&
          settings.fxBufferPct !== null &&
          settings.feeTable.length > 0,
        freelancerConnected: store.accounts.some(
          (a) => a.platform === 'freelancer' && a.status === 'connected',
        ),
        scannerCount: store.scanners.length,
        activeTemplateCount: templatesOf(store).filter(
          (t) => t.active && t.variants.some((/** @type {Row} */ v) => v.active),
        ).length,
        telegramLinked: store.telegramLinked,
      }),
    });
  }
  // ARB-410 in the demo: the sample org is the house org, counted and never limited.
  if (key === 'GET /v1/usage') {
    const now = new Date();
    const local = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
    const next = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1));
    const sent = store.proposals.filter((p) => p.status === 'submitted').length;
    const drafted = store.proposals.length;
    const scored = store.jobs.filter((j) => j.verdict).length;
    return respond(200, {
      plan: { kind: 'exempt' },
      period: {
        start: start.toISOString().slice(0, 10),
        resetsOn: next.toISOString().slice(0, 10),
      },
      metrics: [
        { metric: 'jobs_scored', label: 'Jobs scored', used: scored, limit: null, percent: null },
        {
          metric: 'bids_drafted',
          label: 'Bids drafted',
          used: drafted,
          limit: null,
          percent: null,
        },
        { metric: 'bids_submitted', label: 'Bids sent', used: sent, limit: null, percent: null },
      ],
    });
  }
  // ARB-420 in the demo: the sample org is the house org, and no plan is published (D-12).
  if (key === 'GET /v1/billing') {
    return respond(200, {
      role: 'owner',
      houseOrg: true,
      state: { kind: 'exempt' },
      subscription: null,
      plans: [],
      graceDays: null,
      providers: {
        paystack: { configured: false, environment: null, reason: 'The demo takes no payments.' },
        stripe: { configured: false, environment: null, reason: 'The demo takes no payments.' },
      },
    });
  }
  if (key === 'POST /v1/billing/checkout') {
    return respond(409, { error: 'This is the house organisation: it is not billed.' });
  }
  if (key === 'POST /v1/orgs') {
    return respond(409, {
      error: 'You are already a member of an organisation. Sign in to use it.',
    });
  }
  if (key === 'POST /v1/sessions') {
    logEvent(store, 'auth.signed_in', { subject_table: 'users', subject_id: USER });
    return respond(201, me(store));
  }

  if (key === 'GET /v1/dashboard') {
    const queued = store.proposals.filter((p) => p.status === 'queued').length;
    const submitted = store.proposals.filter((p) => p.status === 'submitted').length;
    return respond(200, {
      period: { start: monthStart().toISOString(), end: new Date().toISOString() },
      currency: 'ZAR',
      revenueInZarMinor: '1850000',
      revenueOutZarMinor: '1120000',
      realisedMarginZarMinor: '730000',
      unconverted: [],
      pipeline: [{ currency: 'ZAR', amountMinor: '2600000', count: 3 }],
      replies: 4,
      bids: { queued, submitted, won: 2, lost: 1 },
      winRate: 2 / 3,
      // ARB-312: the sum of the tab's active retainers, per currency, as the API sums them.
      retainers: Object.values(
        (store.pipeline ?? [])
          .filter((p) => p.retainer && p.stage !== 'lost' && p.currency)
          .reduce((acc, p) => {
            const line = acc[p.currency] ?? { currency: p.currency, amountMinor: '0', count: 0 };
            line.amountMinor = (
              BigInt(line.amountMinor) + BigInt(p.retainerMonthlyMinor)
            ).toString();
            line.count += 1;
            acc[p.currency] = line;
            return acc;
          }, /** @type {Record<string, Row>} */ ({})),
      ).sort((a, b) => String(a.currency).localeCompare(String(b.currency))),
    });
  }

  if (key === 'GET /v1/jobs') {
    const verdict = url.searchParams.get('verdict');
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const rows = store.jobs
      .filter((row) =>
        !verdict ? true : verdict === 'unscored' ? row.verdict === null : row.verdict === verdict,
      )
      .slice(offset, offset + limit);
    return respond(200, { jobs: rows, page: { limit, offset } });
  }
  if (method === 'POST' && /^\/v1\/jobs\/[^/]+\/queue-bid$/.test(path)) {
    const row = store.jobs.find((j) => j.id === idIn('/v1/jobs/'));
    if (!row) return respond(404, { error: 'no such job' });
    if (row.proposal_status && ['queued', 'approved', 'submitted'].includes(row.proposal_status)) {
      return respond(409, { error: `a bid for this job is already ${row.proposal_status}` });
    }
    if (row.verdict === null) {
      row.score = 58;
      row.verdict = 'caution';
      logEvent(store, 'proposal.draft_requested', { subject_table: 'jobs', subject_id: row.id });
      return respond(202, { action: 'scoring', jobId: row.id });
    }
    if (row.verdict === 'skip') return respond(422, { error: 'this job was scored skip' });
    if (row.margin_passed === false) {
      return respond(422, { error: row.margin_reason ?? 'the margin check failed' });
    }
    const bid = proposalFor(row, {});
    store.proposals.unshift(bid);
    row.proposal_id = bid.id;
    row.proposal_status = 'queued';
    logEvent(store, 'proposal.draft_requested', { subject_table: 'jobs', subject_id: row.id });
    return respond(202, { action: 'drafting', jobId: row.id });
  }

  // ARB-122 in the demo: replies waiting for approval, kept in the tab; nothing is sent.
  const outbound = store.outbound ?? [];
  if (key === 'GET /v1/outbound-messages') {
    const state = url.searchParams.get('status') ?? 'queued';
    return respond(200, { messages: outbound.filter((m) => state === 'all' || m.state === state) });
  }
  if (method === 'POST' && /^\/v1\/outbound-messages\/[^/]+\/(approve|reject)$/.test(path)) {
    const row = outbound.find((m) => m.id === idIn('/v1/outbound-messages/'));
    if (!row) return respond(404, { error: 'no such message' });
    const action = path.endsWith('/approve') ? 'approve' : 'reject';
    if (action === 'approve' && row.state !== 'queued')
      return respond(409, { error: `This message is ${row.state}.` });
    if (action === 'reject' && !String(body?.reason ?? '').trim()) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'reason', message: 'must not be empty' }],
      });
    }
    if (action === 'reject' && (row.state === 'sent' || row.state === 'rejected'))
      return respond(409, { error: `This message is ${row.state}.` });
    if (action === 'approve') {
      row.state = 'approved';
      row.approvedBy = USER;
      row.approvedByName = 'Demo Owner';
      row.approvedVia = 'web';
    } else {
      row.state = 'rejected';
      row.rejectedAt = new Date().toISOString();
      row.failureReason = body.reason;
      row.approvedBy = null;
      row.approvedByName = null;
      row.approvedVia = null;
    }
    row.updatedAt = new Date().toISOString();
    logEvent(store, action === 'approve' ? 'message.approved' : 'message.rejected', {
      subject_table: 'messages',
      subject_id: row.id,
      payload: { via: 'web', ...(action === 'reject' ? { reason: body.reason } : {}) },
    });
    return respond(200, { message: row, ...(action === 'approve' ? { queued: false } : {}) });
  }
  if (method === 'PATCH' && /^\/v1\/outbound-messages\/[^/]+$/.test(path)) {
    const row = outbound.find((m) => m.id === idIn('/v1/outbound-messages/'));
    if (!row) return respond(404, { error: 'no such message' });
    if (row.state === 'sent') return respond(409, { error: 'This message has already been sent.' });
    const validated = validateMessageDraft(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    row.body = validated.value.text;
    row.state = 'queued';
    row.approvedBy = null;
    row.approvedByName = null;
    row.approvedVia = null;
    row.rejectedAt = null;
    row.failureReason = null;
    row.updatedAt = new Date().toISOString();
    logEvent(store, 'message.edited', { subject_table: 'messages', subject_id: row.id });
    return respond(200, { message: row });
  }

  // ARB-140 in the demo: the conversations page. Rules are @arbitron/core's, as in the API.
  const threads = store.threads ?? [];
  const inbound = store.inbound ?? [];
  const discovery = store.discovery ?? [];
  const briefs = store.briefs ?? [];
  /** @param {Row} t @returns {Row} */
  const describeThread = (t) => {
    const messages = threadMessages(t.id);
    const last = messages.at(-1) ?? null;
    const session = discovery.find((d) => d.threadId === t.id) ?? null;
    const current =
      briefs.filter((b) => b.threadId === t.id).sort((a, b) => b.version - a.version)[0] ?? null;
    return {
      ...t,
      lastMessageAt: last ? (last.sentAt ?? last.createdAt) : null,
      messageCount: messages.length,
      pendingReplies: messages.filter((m) => m.state === 'queued' || m.state === 'approved').length,
      lastMessage: last
        ? { direction: last.direction, body: last.body, sentAt: last.sentAt }
        : null,
      discovery: session ? { completeness: discoveryCompleteness(session.answers) } : null,
      brief: current ? { id: current.id, version: current.version, locked: current.locked } : null,
      updatedAt: last ? (last.sentAt ?? last.createdAt) : t.createdAt,
    };
  };
  /** @param {string} threadId */
  function threadMessages(threadId) {
    const drafts = outbound
      .filter((m) => m.threadId === threadId)
      .map((m) => ({
        id: m.id,
        direction: 'out',
        origin: 'app',
        body: m.body,
        state: m.state,
        sentAt: m.sentAt,
        approvedByName: m.approvedByName,
        approvedVia: m.approvedVia,
        rejectedAt: m.rejectedAt,
        failureReason: m.failureReason,
        createdAt: m.createdAt,
      }));
    return [...inbound.filter((m) => m.threadId === threadId), ...drafts].sort((a, b) =>
      String(a.sentAt ?? a.createdAt).localeCompare(String(b.sentAt ?? b.createdAt)),
    );
  }
  /** @param {Row} session */
  const describeSession = (session) => ({
    id: session.id,
    threadId: session.threadId,
    version: session.version,
    completeness: discoveryCompleteness(session.answers),
    answers: session.answers,
    asked: session.asked,
    questions: DISCOVERY_QUESTIONS.map((q) => ({
      key: q.key,
      text: q.text,
      answer: session.answers[q.key] ?? null,
      askedAt: session.asked[q.key] ?? null,
    })),
    nextBatch: nextDiscoveryBatch(session.answers, session.asked).map((q) => q.key),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
  /** @param {Row} b */
  const describeBrief = (b) => ({
    ...b,
    lockBlockers: b.locked ? [] : briefLockBlockers(/** @type {any} */ (b)),
  });
  /** @param {Row} b */
  const versionOf = (b) => ({
    id: b.id,
    version: b.version,
    locked: b.locked,
    lockedAt: b.lockedAt,
    updatedAt: b.updatedAt,
  });
  /** A batch of questions drafted as a reply waiting for approval (ARB-130 in the demo). */
  const draftBatch = (/** @type {Row} */ t, /** @type {Row} */ session) => {
    const batch = nextDiscoveryBatch(session.answers, session.asked);
    if (batch.length === 0) return null;
    const now = new Date().toISOString();
    const body = renderDiscoveryBatch(batch, t.clientHandle);
    const row = {
      id: uuid(),
      threadId: t.id,
      externalThreadId: t.externalThreadId,
      clientHandle: t.clientHandle,
      jobId: t.jobId,
      jobTitle: t.jobTitle,
      body,
      state: 'queued',
      approvedBy: null,
      approvedByName: null,
      approvedVia: null,
      sentAt: null,
      rejectedAt: null,
      failureReason: null,
      externalMessageId: null,
      createdAt: now,
      updatedAt: now,
      lastInbound: null,
    };
    outbound.unshift(row);
    for (const q of batch) session.asked[q.key] = now;
    session.updatedAt = now;
    logEvent(store, 'message.drafted', {
      subject_table: 'messages',
      subject_id: row.id,
      payload: { via: 'discovery', thread_id: t.id, questions: batch.map((q) => q.key) },
    });
    return { messageId: row.id, keys: batch.map((q) => q.key), body };
  };

  if (key === 'GET /v1/service-categories') {
    return respond(200, {
      categories: DEMO_CATEGORIES.map((slug) => ({
        slug,
        name: categoryName(slug),
        inHouse: false,
      })),
    });
  }

  // ARB-201 in the demo: sourcing requests ranked by the real rule from the tab's suppliers.
  const sourcing = store.sourcing ?? [];
  /** @param {Row} r @param {boolean} withCandidates */
  const describeSourcing = (r, withCandidates) => {
    const { candidates, ...rest } = r;
    return {
      ...rest,
      candidateCount: candidates.length,
      shortlistedCount: candidates.filter((/** @type {Row} */ c) => c.shortlisted).length,
      ...(withCandidates ? { candidates } : {}),
    };
  };
  if (method === 'POST' && /^\/v1\/briefs\/[^/]+\/sourcing$/.test(path)) {
    const b = (store.briefs ?? []).find((row) => row.id === idIn('/v1/briefs/'));
    if (!b) return respond(404, { error: 'no such brief' });
    if (!b.locked)
      return respond(409, { error: 'The brief must be locked before sourcing starts.' });
    if (b.deliveryRoute === 'in_house') {
      return respond(422, {
        error: 'This brief is delivered in-house, so nothing is sourced (docs/02 D-04).',
      });
    }
    if (
      sourcing.some(
        (r) => r.briefId === b.id && ['open', 'shortlisting', 'chosen'].includes(r.status),
      )
    ) {
      return respond(409, { error: 'Sourcing has already started for this brief.' });
    }
    const t = threads.find((row) => row.id === b.threadId);
    const ranking = rankSuppliers(
      {
        category: b.category,
        budget: b.budget,
        deadline: b.deadline,
        deadlineFixed: b.deadlineFixed,
      },
      /** @type {any} */ (
        (store.suppliers ?? []).map((sup) => ({
          ...sup,
          rateCards: sup.rateCards.filter((/** @type {Row} */ c) => c.categorySlug === b.category),
        }))
      ),
      { now: new Date() },
    );
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      briefId: b.id,
      briefVersion: b.version,
      briefTitle: b.title,
      category: b.category,
      deliveryRoute: b.deliveryRoute,
      threadId: b.threadId,
      clientHandle: t?.clientHandle ?? null,
      jobTitle: t?.jobTitle ?? null,
      channels: [...new Set(ranking.ranked.map((r) => r.channel))],
      status: 'open',
      excluded: ranking.excluded,
      candidates: ranking.ranked.map((r) => ({
        id: uuid(),
        supplierId: r.supplierId,
        name: r.name,
        channel: r.channel,
        countryCode: r.countryCode,
        timeZone: r.timeZone,
        currency: r.currency,
        quotedPriceMinor: r.quotedPriceMinor,
        priced: r.priced,
        turnaroundDays: r.turnaroundDays,
        score: r.score,
        parts: r.parts,
        reasons: r.reasons,
        shortlisted: false,
      })),
      createdAt: now,
      updatedAt: now,
    };
    sourcing.unshift(row);
    store.sourcing = sourcing;
    logEvent(store, 'sourcing.requested', {
      subject_table: 'sourcing_requests',
      subject_id: row.id,
      payload: {
        via: 'web',
        brief_id: b.id,
        category: b.category,
        ranked: ranking.ranked.length,
        excluded: ranking.excluded.length,
      },
    });
    return respond(201, { request: describeSourcing(row, true) });
  }
  if (method === 'GET' && /^\/v1\/briefs\/[^/]+\/sourcing$/.test(path)) {
    const row = sourcing.find((r) => r.briefId === idIn('/v1/briefs/'));
    return respond(200, { request: row ? describeSourcing(row, true) : null });
  }
  if (key === 'GET /v1/sourcing-requests') {
    return respond(200, { requests: sourcing.map((r) => describeSourcing(r, false)) });
  }
  if (method === 'GET' && /^\/v1\/sourcing-requests\/[^/]+$/.test(path)) {
    const row = sourcing.find((r) => r.id === idIn('/v1/sourcing-requests/'));
    if (!row) return respond(404, { error: 'no such sourcing request' });
    return respond(200, { request: describeSourcing(row, true) });
  }
  if (method === 'PATCH' && /^\/v1\/sourcing-requests\/[^/]+\/candidates\/[^/]+$/.test(path)) {
    const row = sourcing.find((r) => r.id === idIn('/v1/sourcing-requests/'));
    if (!row) return respond(404, { error: 'no such sourcing request' });
    const candidateId = path.split('/').pop();
    const candidate = row.candidates.find((/** @type {Row} */ c) => c.id === candidateId);
    if (!candidate) return respond(404, { error: 'no such candidate on this request' });
    if (typeof body?.shortlisted !== 'boolean') {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'shortlisted', message: 'must be true or false' }],
      });
    }
    candidate.shortlisted = body.shortlisted;
    row.status = row.candidates.some((/** @type {Row} */ c) => c.shortlisted)
      ? 'shortlisting'
      : 'open';
    row.updatedAt = new Date().toISOString();
    logEvent(store, 'sourcing.shortlisted', {
      subject_table: 'supplier_candidates',
      subject_id: candidate.id,
      payload: { via: 'web', sourcing_request_id: row.id, shortlisted: body.shortlisted },
    });
    return respond(200, { request: describeSourcing(row, true) });
  }

  if (
    method === 'POST' &&
    /^\/v1\/sourcing-requests\/[^/]+\/candidates\/[^/]+\/reprice$/.test(path)
  ) {
    const row = sourcing.find((r) => r.id === idIn('/v1/sourcing-requests/'));
    if (!row) return respond(404, { error: 'no such sourcing request' });
    const candidateId = path.split('/').at(-2);
    const candidate = row.candidates.find((/** @type {Row} */ c) => c.id === candidateId);
    if (!candidate) return respond(404, { error: 'no such candidate on this request' });
    if (candidate.quotedPriceMinor === null) {
      return respond(409, {
        error: 'This candidate has no quote yet, so there is nothing to reprice with.',
      });
    }
    const t = (store.threads ?? []).find((x) => x.id === row.threadId);
    const j = t?.jobId ? store.jobs.find((x) => x.id === t.jobId) : undefined;
    if (!j) {
      return respond(409, {
        error:
          'The conversation behind this brief has no job, so there is no bid margin to reprice.',
      });
    }
    const { margin, reprice } = demoReprice(store.settings, j, candidate);
    candidate.margin = margin;
    candidate.reprice = reprice;
    store.events.unshift(
      event('margin.repriced', {
        subject_table: 'supplier_candidates',
        subject_id: candidate.id,
        outcome: reprice.outcome,
        payload: {
          candidate: candidate.name,
          sourcing_request_id: row.id,
          ...(reprice.outcome === 'ok'
            ? { quote_minor: candidate.quotedPriceMinor, after: margin }
            : { reason: reprice.reason, detail: reprice.detail, message: reprice.message }),
        },
      }),
    );
    return respond(202, { queued: true });
  }

  // ARB-310 in the demo: the pipeline and delivery orders, by core's rules.
  const pipeline = store.pipeline ?? [];
  const orders = store.orders ?? [];
  store.pipeline = pipeline;
  store.orders = orders;
  /** @param {Row} o */
  const describeOrder = (o) => {
    const item = pipeline.find((p) => p.id === o.pipelineItemId);
    const state = {
      status: o.status,
      supplierChosen: true,
      agreedCostMinor: o.agreedCostMinor === null ? null : Number(o.agreedCostMinor),
      currency: o.currency,
      milestones: o.milestones,
      handover: o.handover,
      pipelineStage: item?.stage ?? 'applied',
    };
    return {
      ...o,
      jobTitle: item?.jobTitle ?? 'Unknown job',
      pipelineStage: state.pipelineStage,
      milestonesTotalMinor: milestoneTotal(o.milestones).toString(),
      reconciled:
        state.agreedCostMinor !== null &&
        o.milestones.length > 0 &&
        reconcileMilestones(o.milestones, state.agreedCostMinor, o.currency).ok,
      moves: Object.fromEntries(
        (DELIVERY_TRANSITIONS[/** @type {'draft'} */ (o.status)] ?? []).map(
          (/** @type {any} */ to) => [to, transitionBlockers(/** @type {any} */ (state), to)],
        ),
      ),
    };
  };
  /** @param {Row} item @param {string} to */
  const moveStage = (item, to) => {
    if (item.stage === to) return;
    const from = item.stage;
    item.stage = to;
    item.stageChangedAt = new Date().toISOString();
    logEvent(store, 'pipeline.stage_changed', {
      subject_table: 'pipeline_items',
      subject_id: item.id,
      payload: { via: 'web', from, to },
    });
  };
  const orderIn = () => orders.find((o) => o.id === path.split('/')[3]);
  if (key === 'GET /v1/pipeline') {
    return respond(200, {
      stages: PIPELINE_STAGES,
      items: pipeline.map((item) => {
        const live = orders.find((o) => o.pipelineItemId === item.id && o.status !== 'cancelled');
        return { ...item, deliveryOrderId: live?.id ?? null, deliveryStatus: live?.status ?? null };
      }),
    });
  }
  if (method === 'PATCH' && /^\/v1\/pipeline-items\/[^/]+$/.test(path)) {
    const item = pipeline.find((p) => p.id === path.split('/').pop());
    if (!item) return respond(404, { error: 'no such pipeline item' });
    if (body?.stage === undefined && body?.retainer === undefined)
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'stage', message: 'send a stage, a retainer, or both' }],
      });
    if (body?.stage !== undefined && !PIPELINE_STAGES.includes(body.stage)) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'stage', message: `must be one of ${PIPELINE_STAGES.join(', ')}` }],
      });
    }
    if (body?.retainer !== undefined) {
      const validated = validateRetainer(body);
      if (!validated.ok)
        return respond(422, { error: 'the request was not accepted', errors: validated.errors });
      const currency =
        item.currency ?? (typeof body.currency === 'string' ? body.currency.toUpperCase() : null);
      if (validated.value.retainer && !currency)
        return respond(422, {
          error: 'the request was not accepted',
          errors: [
            {
              field: 'currency',
              message: 'the job has no currency recorded; send the retainer’s currency with it',
            },
          ],
        });
      const from = { retainer: item.retainer, monthly_minor: item.retainerMonthlyMinor };
      item.retainer = validated.value.retainer;
      item.retainerMonthlyMinor =
        validated.value.retainerMonthlyMinor === null
          ? null
          : String(validated.value.retainerMonthlyMinor);
      item.currency = currency;
      logEvent(store, 'pipeline.retainer_changed', {
        subject_table: 'pipeline_items',
        subject_id: item.id,
        payload: {
          via: 'web',
          from,
          to: { retainer: item.retainer, monthly_minor: item.retainerMonthlyMinor },
        },
      });
    }
    if (body?.stage !== undefined) moveStage(item, body.stage);
    return respond(200, {
      id: item.id,
      stage: item.stage,
      retainer: item.retainer,
      retainerMonthlyMinor: item.retainerMonthlyMinor,
      currency: item.currency,
    });
  }
  if (
    method === 'POST' &&
    /^\/v1\/sourcing-requests\/[^/]+\/candidates\/[^/]+\/choose$/.test(path)
  ) {
    const row = sourcing.find((r) => r.id === idIn('/v1/sourcing-requests/'));
    if (!row) return respond(404, { error: 'no such sourcing request' });
    const candidateId = path.split('/').at(-2);
    const candidate = row.candidates.find((/** @type {Row} */ c) => c.id === candidateId);
    if (!candidate) return respond(404, { error: 'no such candidate on this request' });
    if (!['open', 'shortlisting'].includes(row.status))
      return respond(409, {
        error: `This request is ${String(row.status)}, so a supplier cannot be chosen on it.`,
      });
    if (candidate.quotedPriceMinor === null)
      return respond(409, {
        error: 'This candidate has no quote yet, so there is no cost to agree. Ask for one first.',
      });
    const t = (store.threads ?? []).find((x) => x.id === row.threadId);
    const item = pipeline.find((p) => p.jobId === t?.jobId);
    if (!item)
      return respond(409, {
        error: 'This job has no pipeline item yet: it appears when the bid is submitted.',
      });
    if (orders.some((o) => o.pipelineItemId === item.id && o.status !== 'cancelled'))
      return respond(409, {
        error:
          'This job already has a delivery order. Cancel it on the pipeline page before choosing another supplier.',
      });
    const b = (store.briefs ?? []).find((x) => x.id === row.briefId);
    const order = {
      id: uuid(),
      pipelineItemId: item.id,
      status: 'draft',
      briefTitle: b?.title ?? null,
      supplierName: candidate.name,
      supplierId: candidate.supplierId ?? null,
      supplierCandidateId: candidate.id,
      sourcingRequestId: row.id,
      agreedCostMinor: candidate.quotedPriceMinor,
      currency: candidate.currency,
      due: b?.deadline ?? null,
      milestones: [
        {
          title: 'Full delivery',
          amountMinor: Number(candidate.quotedPriceMinor),
          due: b?.deadline ?? null,
          status: 'pending',
        },
      ],
      handover: b ? handoverChecklist(/** @type {any} */ (b)) : [],
      handedOverAt: null,
      deliveredAt: null,
      acceptedAt: null,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orders.unshift(order);
    row.status = 'chosen';
    candidate.shortlisted = true;
    logEvent(store, 'delivery.order_created', {
      subject_table: 'delivery_orders',
      subject_id: order.id,
      payload: {
        via: 'web',
        sourcing_request_id: row.id,
        supplier: candidate.name,
        agreed_cost_minor: candidate.quotedPriceMinor,
        currency: candidate.currency,
      },
    });
    return respond(201, { order: describeOrder(order) });
  }
  if (key === 'GET /v1/delivery-orders') {
    const wanted = url.searchParams.get('status') ?? 'all';
    return respond(200, {
      orders: orders.filter((o) => wanted === 'all' || o.status === wanted).map(describeOrder),
    });
  }
  if (method === 'GET' && /^\/v1\/delivery-orders\/[^/]+$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    return respond(200, { order: describeOrder(o) });
  }
  if (method === 'PATCH' && /^\/v1\/delivery-orders\/[^/]+$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    const validated = validateDeliveryOrderEdit(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    if (!['draft', 'assigned'].includes(o.status))
      return respond(409, {
        error: `This order is ${String(o.status).replace('_', ' ')}, so its cost and milestones are fixed.`,
      });
    o.agreedCostMinor = String(validated.value.agreedCostMinor);
    o.currency = validated.value.currency;
    o.milestones = validated.value.milestones;
    o.due = validated.value.due;
    o.updatedAt = new Date().toISOString();
    logEvent(store, 'delivery.order_edited', {
      subject_table: 'delivery_orders',
      subject_id: o.id,
      payload: {
        via: 'web',
        agreed_cost_minor: o.agreedCostMinor,
        milestones: o.milestones.length,
      },
    });
    return respond(200, { order: describeOrder(o) });
  }
  if (method === 'POST' && /^\/v1\/delivery-orders\/[^/]+\/status$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    const to = body?.status;
    const described = describeOrder(o);
    const reasons = described.moves[to];
    if (!reasons)
      return respond(409, {
        error: transitionBlockers(
          /** @type {any} */ ({
            ...o,
            pipelineStage: described.pipelineStage,
            supplierChosen: true,
            agreedCostMinor: Number(o.agreedCostMinor),
          }),
          to,
        ).join(' '),
      });
    if (reasons.length > 0) return respond(409, { error: reasons.join(' ') });
    const from = o.status;
    o.status = to;
    const now = new Date().toISOString();
    if (to === 'in_progress') o.handedOverAt = now;
    if (to === 'delivered') o.deliveredAt = now;
    if (to === 'accepted') o.acceptedAt = now;
    if (to === 'cancelled') {
      o.cancelledAt = now;
      const request = sourcing.find((r) => r.id === o.sourcingRequestId);
      if (request?.status === 'chosen') request.status = 'shortlisting';
    }
    logEvent(store, 'delivery.status_changed', {
      subject_table: 'delivery_orders',
      subject_id: o.id,
      payload: { via: 'web', from, to },
    });
    const stage = pipelineStageFor(to);
    const item = pipeline.find((p) => p.id === o.pipelineItemId);
    if (stage && item) moveStage(item, stage);
    return respond(200, { order: describeOrder(o) });
  }
  if (method === 'PATCH' && /^\/v1\/delivery-orders\/[^/]+\/handover\/[^/]+$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    if (!['draft', 'assigned'].includes(o.status))
      return respond(409, {
        error: `This order is ${String(o.status).replace('_', ' ')}, so its handover is closed.`,
      });
    const itemKey = decodeURIComponent(path.split('/').pop() ?? '');
    const entry = o.handover.find((/** @type {Row} */ h) => h.key === itemKey);
    if (!entry) return respond(404, { error: 'no such handover item on this order' });
    entry.done = body?.done === true;
    logEvent(store, 'delivery.handover_ticked', {
      subject_table: 'delivery_orders',
      subject_id: o.id,
      payload: { via: 'web', key: itemKey, done: entry.done },
    });
    return respond(200, { order: describeOrder(o) });
  }
  if (method === 'PATCH' && /^\/v1\/delivery-orders\/[^/]+\/milestones\/\d+$/.test(path)) {
    const o = orderIn();
    if (!o) return respond(404, { error: 'no such delivery order' });
    if (!['in_progress', 'delivered'].includes(o.status))
      return respond(409, {
        error: 'A milestone is marked once the work has started and until the order is accepted.',
      });
    const m = o.milestones[Number(path.split('/').pop())];
    if (!m) return respond(404, { error: 'no such milestone on this order' });
    if (m.status === 'accepted')
      return respond(409, { error: 'This milestone is accepted; it does not change after that.' });
    const from = m.status;
    m.status = body?.status;
    logEvent(store, 'delivery.milestone_changed', {
      subject_table: 'delivery_orders',
      subject_id: o.id,
      payload: { via: 'web', title: m.title, from, to: m.status },
    });
    return respond(200, { order: describeOrder(o) });
  }

  // ARB-311 in the demo: payments and realised margin, by core's rules. No FX provider.
  const payments = store.payments ?? [];
  store.payments = payments;
  /** @param {Row} item */
  const paymentsView = (item) => {
    const mine = payments.filter((y) => y.pipelineItemId === item.id);
    const storedRows = mine.map((y) => ({
      kind: y.kind,
      amountMinor: Number(y.amountMinor),
      currency: y.currency,
      amountZarMinor: y.amountZarMinor === null ? null : Number(y.amountZarMinor),
    }));
    const m = realisedMargin(storedRows);
    return {
      item: {
        id: item.id,
        jobTitle: item.jobTitle,
        stage: item.stage,
        valueMinor: item.valueMinor,
        currency: item.currency,
      },
      orders: orders
        .filter((o) => o.pipelineItemId === item.id && o.status !== 'cancelled')
        .map((o) => ({
          id: o.id,
          status: o.status,
          currency: o.currency,
          supplierName: o.supplierName,
          supplierCountry:
            (store.suppliers ?? []).find((x) => x.id === o.supplierId)?.countryCode ?? null,
          milestones: o.milestones,
        })),
      payments: mine,
      margin: {
        inZarMinor: m.inZarMinor.toString(),
        supplierZarMinor: m.supplierZarMinor.toString(),
        feesZarMinor: m.feesZarMinor.toString(),
        otherZarMinor: m.otherZarMinor.toString(),
        marginZarMinor: m.marginZarMinor.toString(),
        unconverted: m.unconverted.map((u) => ({ ...u, amountMinor: String(u.amountMinor) })),
      },
      paidInFull: clientPaidInFull(
        storedRows,
        item.valueMinor === null ? null : Number(item.valueMinor),
        item.currency,
      ),
    };
  };
  if (method === 'GET' && /^\/v1\/pipeline-items\/[^/]+\/payments$/.test(path)) {
    const item = pipeline.find((x) => x.id === path.split('/')[3]);
    if (!item) return respond(404, { error: 'no such pipeline item' });
    return respond(200, paymentsView(item));
  }
  if (method === 'POST' && /^\/v1\/pipeline-items\/[^/]+\/payments$/.test(path)) {
    const item = pipeline.find((x) => x.id === path.split('/')[3]);
    if (!item) return respond(404, { error: 'no such pipeline item' });
    const validated = validatePaymentInput(body, { today: sastDay(new Date()) });
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    const v = validated.value;
    if (v.currency !== 'ZAR' && v.fxRate === null)
      return respond(422, {
        error: 'the request was not accepted',
        errors: [
          {
            field: 'fxRate',
            message: `must be typed: a ${v.currency} payment needs the rate to ZAR it was converted at, and no FX provider is configured (docs/02 B-10)`,
          },
        ],
      });
    let notice = null;
    if (v.kind === 'supplier') {
      const o = orders.find((x) => x.id === v.deliveryOrderId && x.pipelineItemId === item.id);
      if (!o)
        return respond(422, {
          error: 'the request was not accepted',
          errors: [{ field: 'deliveryOrderId', message: 'must be a delivery order of this job' }],
        });
      if (o.status === 'draft')
        return respond(409, {
          error: 'A supplier is paid once assigned. Assign the supplier first.',
        });
      const supplier = (store.suppliers ?? []).find((x) => x.id === o.supplierId);
      if (supplier?.countryCode !== 'ZA')
        notice =
          'docs/02 T-05 is open: the legal structure for paying overseas suppliers (Exchange Control/SARB reporting, invoicing, VAT treatment of export services) is to be confirmed with Logi-Ink’s accountant before the first live supplier payment.';
    }
    const zar = zarOf(v.amountMinor, v.currency, v.fxRate);
    const row = {
      id: uuid(),
      pipelineItemId: item.id,
      kind: v.kind,
      direction: directionOf(v.kind),
      amountMinor: String(v.amountMinor),
      currency: v.currency,
      fxRateUsed: v.fxRate,
      fxRateAt: v.fxRate ? new Date(`${v.paidOn}T00:00:00+02:00`).toISOString() : null,
      amountZarMinor: zar === null ? null : String(zar),
      paidAt: new Date(`${v.paidOn}T00:00:00+02:00`).toISOString(),
      reference: v.reference,
      deliveryOrderId: v.deliveryOrderId,
      milestoneIndex: v.milestoneIndex,
      recordedByName: 'Demo Owner',
      createdAt: new Date().toISOString(),
    };
    payments.push(row);
    logEvent(store, 'payment.recorded', {
      subject_table: 'payments',
      subject_id: row.id,
      payload: { via: 'web', kind: v.kind, amount_minor: row.amountMinor, currency: v.currency },
    });
    const view = paymentsView(item);
    if (v.kind === 'client' && item.stage !== 'paid' && view.paidInFull) {
      moveStage(item, 'paid');
      view.item.stage = 'paid';
    }
    return respond(201, { ...view, paymentId: row.id, notice });
  }

  // ARB-320 in the demo: the tab's sent bids, grouped by core's rule as the API groups them.
  if (key === 'GET /v1/analytics') {
    const by = url.searchParams.get('by') ?? 'category';
    if (!ANALYTICS_DIMENSIONS.includes(/** @type {any} */ (by)))
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'by', message: `must be one of ${ANALYTICS_DIMENSIONS.join(', ')}` }],
      });
    const since = url.searchParams.get('since');
    const start = since ? new Date(`${since}T00:00:00+02:00`).getTime() : null;
    const facts = store.proposals
      .filter(
        (p) =>
          p.status === 'submitted' &&
          p.submitted_at &&
          (start === null || new Date(p.submitted_at).getTime() >= start),
      )
      .map((p) => {
        const j = store.jobs.find((x) => x.id === p.job_id) ?? {};
        const item = pipeline.find((x) => x.jobId === p.job_id);
        const order = item
          ? orders.find((o) => o.pipelineItemId === item.id && o.status !== 'cancelled')
          : undefined;
        const replied = repliedAfter(store, p);
        const template = templatesOf(store).find((x) =>
          x.variants.some((/** @type {Row} */ v) => v.id === p.template_variant_id),
        );
        const mine = payments.filter((y) => item && y.pipelineItemId === item.id);
        const zar = (/** @type {string} */ direction) =>
          mine
            .filter((y) => y.direction === direction && y.amountZarMinor !== null)
            .reduce((sum, y) => sum + BigInt(y.amountZarMinor), 0n)
            .toString();
        const category = j.category_slug ?? null;
        return {
          jobId: p.job_id,
          categoryKey: category,
          categoryLabel: category,
          templateKey: template?.id ?? null,
          templateLabel: template?.name ?? null,
          supplierKey: order?.supplierCandidateId ?? null,
          supplierLabel: order?.supplierName ?? null,
          scannerKey: null,
          scannerLabel: null,
          replied,
          won: item ? ['won', 'in_delivery', 'delivered', 'paid'].includes(item.stage) : false,
          lost: item?.stage === 'lost',
          inZarMinor: zar('in'),
          outZarMinor: zar('out'),
          unconvertedPayments: mine.filter((y) => y.amountZarMinor === null).length,
          modelCostNanoUsd: '0',
        };
      });
    return respond(200, {
      by,
      since,
      total: analyticsTotal(facts),
      rows: aggregateAnalytics(facts, /** @type {any} */ (by)),
    });
  }

  // ARB-202 in the demo: sourcing post drafts, checked by the same rules as the API.
  const posts = store.posts ?? [];
  /** @param {Row} request */
  const whoFor = (request) => {
    const b = (store.briefs ?? []).find((row) => row.id === request.briefId);
    return {
      brief: b,
      who: {
        clientHandle: request.clientHandle,
        signOffName: b?.signOff?.name ?? null,
        jobTitle: request.jobTitle,
        jobExternalId: null,
      },
    };
  };
  const postIn = (/** @type {string} */ prefix) =>
    posts.find((row) => row.id === path.slice(prefix.length).split('/')[0]);
  /** @param {Row} p */
  const describePost = (p) => ({ ...p, manual: p.platform !== 'freelancer' });
  const identityRefused = (/** @type {Row[]} */ errors) =>
    respond(422, {
      error: 'The post could identify the client. Take out what is named and save again.',
      errors,
    });
  // ARB-210: every post of the org by status, for the approvals page.
  if (key === 'GET /v1/sourcing-posts') {
    const wanted = url.searchParams.get('status') ?? 'draft';
    if (!['draft', 'approved', 'posted', 'failed', 'closed', 'all'].includes(wanted)) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [
          {
            field: 'status',
            message: 'must be one of draft, approved, posted, failed, closed, all',
          },
        ],
      });
    }
    return respond(200, {
      posts: posts
        .filter((row) => wanted === 'all' || row.status === wanted)
        .map((row) => ({
          ...describePost(row),
          briefTitle:
            sourcing.find((r) => r.id === row.sourcingRequestId)?.briefTitle ?? 'Unknown brief',
        })),
    });
  }
  if (method === 'GET' && /^\/v1\/sourcing-requests\/[^/]+\/posts$/.test(path)) {
    const id = idIn('/v1/sourcing-requests/');
    return respond(200, {
      posts: posts.filter((row) => row.sourcingRequestId === id).map(describePost),
    });
  }
  if (method === 'POST' && /^\/v1\/sourcing-requests\/[^/]+\/posts$/.test(path)) {
    const request = sourcing.find((row) => row.id === idIn('/v1/sourcing-requests/'));
    if (!request) return respond(404, { error: 'no such sourcing request' });
    const platform = body?.platform;
    if (!['freelancer', 'upwork', 'fiverr'].includes(platform)) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'platform', message: 'must be one of freelancer, upwork, fiverr' }],
      });
    }
    if (!['open', 'shortlisting'].includes(request.status))
      return respond(409, {
        error: `This request is ${request.status}, so no new post is drafted for it.`,
      });
    if (
      posts.some(
        (row) =>
          row.sourcingRequestId === request.id &&
          row.platform === platform &&
          ['draft', 'approved', 'posted'].includes(row.status),
      )
    ) {
      return respond(409, {
        error: 'This request already has a post for that platform. Edit it, or close it first.',
      });
    }
    const { brief: b, who } = whoFor(request);
    if (!b) return respond(404, { error: 'no such brief' });
    const draft = buildSourcingPost(/** @type {any} */ (b), {
      categoryName: categoryName(b.category ?? 'project'),
    });
    const problems = clientIdentifyingProblems(draft, who);
    if (problems.length > 0) return identityRefused(problems);
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      sourcingRequestId: request.id,
      platform,
      title: draft.title,
      body: draft.body,
      budgetMinMinor: null,
      budgetMaxMinor: null,
      currency: null,
      status: 'draft',
      approvedBy: null,
      approvedByName: null,
      approvedVia: null,
      externalId: null,
      postedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    posts.push(row);
    store.posts = posts;
    logEvent(store, 'sourcing.post_drafted', {
      subject_table: 'sourcing_posts',
      subject_id: row.id,
      payload: { via: 'web', sourcing_request_id: request.id, platform },
    });
    return respond(201, { post: describePost(row) });
  }
  if (method === 'PATCH' && /^\/v1\/sourcing-posts\/[^/]+$/.test(path)) {
    const row = postIn('/v1/sourcing-posts/');
    if (!row) return respond(404, { error: 'no such sourcing post' });
    const validated = validateSourcingPostEdit(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    if (!['draft', 'approved'].includes(row.status))
      return respond(409, { error: `This post is ${row.status}, so it cannot be changed.` });
    const request = sourcing.find((r) => r.id === row.sourcingRequestId);
    const problems = request ? clientIdentifyingProblems(validated.value, whoFor(request).who) : [];
    if (problems.length > 0) return identityRefused(problems);
    const cleared = row.status === 'approved';
    const v = validated.value;
    Object.assign(row, {
      title: v.title,
      body: v.body,
      budgetMinMinor: v.budgetMinMinor === null ? null : String(v.budgetMinMinor),
      budgetMaxMinor: v.budgetMaxMinor === null ? null : String(v.budgetMaxMinor),
      currency: v.currency,
      status: 'draft',
      approvedBy: null,
      approvedByName: null,
      approvedVia: null,
      updatedAt: new Date().toISOString(),
    });
    logEvent(store, 'sourcing.post_edited', {
      subject_table: 'sourcing_posts',
      subject_id: row.id,
      payload: { via: 'web', cleared_approval: cleared },
    });
    return respond(200, { post: describePost(row) });
  }
  if (method === 'POST' && /^\/v1\/sourcing-posts\/[^/]+\/(approve|posted|close)$/.test(path)) {
    const row = postIn('/v1/sourcing-posts/');
    if (!row) return respond(404, { error: 'no such sourcing post' });
    const action = path.split('/').pop();
    const now = new Date().toISOString();
    if (action === 'approve') {
      if (row.status !== 'draft')
        return respond(409, { error: `This post is ${row.status}, so it cannot be approved.` });
      if (
        row.platform === 'freelancer' &&
        (!row.currency || (row.budgetMinMinor === null && row.budgetMaxMinor === null))
      ) {
        return respond(409, {
          error: 'A Freelancer.com post needs a budget before it is approved. Edit it to add one.',
        });
      }
      if (row.platform === 'freelancer') {
        // Live mode is off in the demo: the sender records what it would have posted.
        logEvent(store, 'external.blocked_by_live_mode', {
          actor_kind: 'system',
          actor_user_id: null,
          outcome: 'blocked',
          subject_table: 'sourcing_posts',
          subject_id: row.id,
          payload: { wouldSend: { call: 'projects/0.1/projects', title: row.title } },
        });
      }
      Object.assign(row, {
        status: 'approved',
        approvedBy: USER,
        approvedByName: 'Demo Owner',
        approvedVia: 'web',
      });
      logEvent(store, 'sourcing.post_approved', {
        subject_table: 'sourcing_posts',
        subject_id: row.id,
        payload: { via: 'web', platform: row.platform },
      });
    } else if (action === 'posted') {
      if (row.platform === 'freelancer') {
        return respond(409, {
          error:
            'Freelancer.com posts are made through its API after approval, not recorded by hand.',
        });
      }
      if (row.status !== 'approved')
        return respond(409, { error: 'Only an approved post can be recorded as posted.' });
      Object.assign(row, { status: 'posted', postedAt: now });
      logEvent(store, 'sourcing.posted', {
        subject_table: 'sourcing_posts',
        subject_id: row.id,
        payload: { via: 'manual', platform: row.platform },
      });
    } else {
      if (row.status === 'closed') return respond(409, { error: 'This post is already closed.' });
      const was = row.status;
      row.status = 'closed';
      logEvent(store, 'sourcing.post_closed', {
        subject_table: 'sourcing_posts',
        subject_id: row.id,
        payload: { via: 'web', was },
      });
    }
    row.updatedAt = now;
    return respond(200, { post: describePost(row) });
  }

  // ARB-340 in the demo: templates and their variants, held to the API's rules.
  if (key === 'GET /v1/templates') {
    return respond(200, { templates: templatesOf(store).map((t) => templateView(store, t)) });
  }
  /** @param {{ field: string, message: string }[]} errors */
  const refused = (errors) => respond(422, { error: 'the request was not accepted', errors });
  /** @param {Row} change @param {Row | null} self */
  const templateProblems = (change, self) => {
    if (change.categorySlug && !DEMO_CATEGORIES.includes(change.categorySlug))
      return [{ field: 'categorySlug', message: 'is not a service category' }];
    if (
      change.name !== undefined &&
      templatesOf(store).some((x) => x !== self && x.name === change.name)
    )
      return [{ field: 'name', message: 'is already used by another template' }];
    return [];
  };
  if (key === 'POST /v1/templates') {
    const checked = validateTemplateChange(body, { partial: false });
    if (!checked.ok) return refused(checked.errors);
    const problems = templateProblems(checked.value, null);
    if (problems.length > 0) return refused(problems);
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      name: checked.value.name,
      categorySlug: checked.value.categorySlug ?? null,
      description: checked.value.description ?? null,
      active: checked.value.active ?? true,
      variants: [],
      createdAt: now,
      updatedAt: now,
    };
    templatesOf(store).unshift(row);
    logEvent(store, 'template.created', {
      subject_table: 'templates',
      subject_id: row.id,
      payload: { via: 'web', name: row.name, category_slug: row.categorySlug },
    });
    return respond(201, { template: templateView(store, row) });
  }
  if (method === 'PATCH' && /^\/v1\/templates\/[^/]+$/.test(path)) {
    const row = templatesOf(store).find((x) => x.id === path.split('/')[3]);
    if (!row) return respond(404, { error: 'no such template' });
    const checked = validateTemplateChange(body, { partial: true });
    if (!checked.ok) return refused(checked.errors);
    const problems = templateProblems(checked.value, row);
    if (problems.length > 0) return refused(problems);
    Object.assign(row, checked.value, { updatedAt: new Date().toISOString() });
    logEvent(store, 'template.updated', { subject_table: 'templates', subject_id: row.id });
    return respond(200, { template: templateView(store, row) });
  }
  if (method === 'POST' && /^\/v1\/templates\/[^/]+\/variants$/.test(path)) {
    const row = templatesOf(store).find((x) => x.id === path.split('/')[3]);
    if (!row) return respond(404, { error: 'no such template' });
    const checked = validateVariantChange(body, { partial: false });
    if (!checked.ok) return refused(checked.errors);
    if (row.variants.some((/** @type {Row} */ v) => v.label === checked.value.label))
      return refused([{ field: 'label', message: 'is already used in this template' }]);
    const now = new Date().toISOString();
    const v = {
      id: uuid(),
      label: checked.value.label,
      body: checked.value.body,
      active: checked.value.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    row.variants.push(v);
    logEvent(store, 'template.variant_created', {
      subject_table: 'template_variants',
      subject_id: v.id,
      payload: { via: 'web', template_id: row.id, label: v.label },
    });
    return respond(201, { template: templateView(store, row) });
  }
  if (method === 'PATCH' && /^\/v1\/template-variants\/[^/]+$/.test(path)) {
    const id = path.split('/')[3];
    const row = templatesOf(store).find((x) =>
      x.variants.some((/** @type {Row} */ v) => v.id === id),
    );
    const v = row?.variants.find((/** @type {Row} */ x) => x.id === id);
    if (!row || !v) return respond(404, { error: 'no such variant' });
    const checked = validateVariantChange(body, { partial: true });
    if (!checked.ok) return refused(checked.errors);
    if (checked.value.body !== undefined && checked.value.body !== v.body) {
      const sent =
        templateView(store, row).variants.find((/** @type {Row} */ x) => x.id === id)?.sends ?? 0;
      const locked = variantWordsLocked(sent);
      if (locked) return respond(409, { error: locked });
    }
    if (
      checked.value.label !== undefined &&
      row.variants.some((/** @type {Row} */ x) => x !== v && x.label === checked.value.label)
    )
      return refused([{ field: 'label', message: 'is already used in this template' }]);
    Object.assign(v, checked.value, { updatedAt: new Date().toISOString() });
    logEvent(store, 'template.variant_updated', {
      subject_table: 'template_variants',
      subject_id: v.id,
      payload: { via: 'web', template_id: row.id },
    });
    return respond(200, { template: templateView(store, row) });
  }

  // ARB-200 in the demo: the supplier database, the template, the export and the import,
  // checked by the same rule the API runs. Nothing here is a real rate.
  const suppliers = store.suppliers ?? [];
  if (key === 'GET /v1/suppliers') return respond(200, { suppliers });
  if (key === 'GET /v1/suppliers/template.csv') {
    return csvFile(supplierCsvTemplate(), 'suppliers-template.csv', null);
  }
  if (key === 'GET /v1/suppliers.csv') {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return csvFile(
      suppliersToCsv(/** @type {any} */ (suppliers)),
      `suppliers-${stamp}.csv`,
      suppliers.length,
    );
  }
  if (key === 'POST /v1/suppliers/import') {
    if (typeof body?.csv !== 'string') {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'csv', message: 'must be the file as text' }],
      });
    }
    const checked = validateSupplierCsv(body.csv, { categories: new Set(DEMO_CATEGORIES) });
    if (!checked.ok) {
      const lines = new Set(checked.errors.map((e) => e.line)).size;
      return respond(422, {
        error: `${String(lines)} line${lines === 1 ? ' has' : 's have'} problems; nothing was imported.`,
        errors: checked.errors,
      });
    }
    const rateCards = checked.value.reduce((n, s) => n + s.rateCards.length, 0);
    if (body.dryRun === true) {
      return respond(200, {
        ok: true,
        dryRun: true,
        lines: checked.lines,
        suppliers: checked.value.length,
        rateCards,
        created: 0,
        updated: 0,
      });
    }
    let created = 0;
    let updated = 0;
    const now = new Date().toISOString();
    for (const s of checked.value) {
      let row = suppliers.find((r) => r.name.toLowerCase() === s.name.toLowerCase());
      if (row) updated += 1;
      else {
        row = { id: uuid(), rateCards: [], createdAt: now };
        suppliers.push(row);
        created += 1;
      }
      Object.assign(row, {
        name: s.name,
        countryCode: s.countryCode,
        timeZone: s.timeZone,
        channel: s.channel,
        languages: s.languages,
        qualityScore: s.qualityScore,
        onTimeRate: s.onTimeRate,
        paysAfterDelivery: s.paysAfterDelivery,
        externalProfileUrl: s.externalProfileUrl,
        notes: s.notes,
        active: s.active,
        updatedAt: now,
      });
      for (const card of s.rateCards) {
        const existing = row.rateCards.find(
          (/** @type {Row} */ c) =>
            c.categorySlug === card.categorySlug && c.currency === card.currency,
        );
        const fields = {
          categorySlug: card.categorySlug,
          categoryName: categoryName(card.categorySlug),
          currency: card.currency,
          fixedPriceMinor: card.fixedPriceMinor,
          hourlyRateMinor: card.hourlyRateMinor,
          turnaroundDays: card.turnaroundDays,
        };
        if (existing) Object.assign(existing, fields);
        else row.rateCards.push({ id: uuid(), ...fields });
      }
    }
    suppliers.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    store.suppliers = suppliers;
    logEvent(store, 'supplier.imported', {
      subject_table: 'suppliers',
      payload: {
        via: 'web',
        lines: checked.lines,
        suppliers: checked.value.length,
        rate_cards: rateCards,
        created,
        updated,
      },
    });
    return respond(200, {
      ok: true,
      dryRun: false,
      lines: checked.lines,
      suppliers: checked.value.length,
      rateCards,
      created,
      updated,
    });
  }
  if (key === 'GET /v1/threads') {
    const wanted = url.searchParams.get('status');
    const rows = threads
      .map(describeThread)
      .filter((t) => !wanted || t.status === wanted)
      .sort((a, b) => String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? '')));
    return respond(200, { threads: rows, page: { limit: 50, offset: 0 } });
  }
  if (method === 'GET' && /^\/v1\/threads\/[^/]+$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    if (!t) return respond(404, { error: 'no such thread' });
    return respond(200, { thread: describeThread(t), messages: threadMessages(t.id) });
  }
  if (method === 'POST' && /^\/v1\/threads\/[^/]+\/messages$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    if (!t) return respond(404, { error: 'no such thread' });
    const validated = validateMessageDraft(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    const now = new Date().toISOString();
    const lastIn = inbound.filter((m) => m.threadId === t.id && m.direction === 'in').at(-1);
    const row = {
      id: uuid(),
      threadId: t.id,
      externalThreadId: t.externalThreadId,
      clientHandle: t.clientHandle,
      jobId: t.jobId,
      jobTitle: t.jobTitle,
      body: validated.value.text,
      state: 'queued',
      approvedBy: null,
      approvedByName: null,
      approvedVia: null,
      sentAt: null,
      rejectedAt: null,
      failureReason: null,
      externalMessageId: null,
      createdAt: now,
      updatedAt: now,
      lastInbound: lastIn ? { body: lastIn.body, sentAt: lastIn.sentAt } : null,
    };
    outbound.unshift(row);
    store.outbound = outbound;
    logEvent(store, 'message.drafted', {
      subject_table: 'messages',
      subject_id: row.id,
      payload: { via: 'web', thread_id: t.id, bodyLength: row.body.length },
    });
    return respond(201, { message: row });
  }
  if (method === 'GET' && /^\/v1\/threads\/[^/]+\/discovery$/.test(path)) {
    const session = discovery.find((d) => d.threadId === idIn('/v1/threads/'));
    return respond(200, { session: session ? describeSession(session) : null });
  }
  if (method === 'POST' && /^\/v1\/threads\/[^/]+\/discovery$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    if (!t) return respond(404, { error: 'no such thread' });
    if (discovery.some((d) => d.threadId === t.id))
      return respond(409, { error: 'Discovery has already started on this thread.' });
    const now = new Date().toISOString();
    const session = {
      id: uuid(),
      threadId: t.id,
      version: '1',
      answers: {},
      asked: {},
      createdAt: now,
      updatedAt: now,
    };
    discovery.push(session);
    store.discovery = discovery;
    const draft = draftBatch(t, session);
    logEvent(store, 'discovery.updated', {
      subject_table: 'discovery_sessions',
      subject_id: session.id,
      payload: { via: 'web', started: true, drafted: draft?.keys ?? [] },
    });
    return respond(201, { session: describeSession(session), draft });
  }
  if (method === 'PATCH' && /^\/v1\/threads\/[^/]+\/discovery\/answers$/.test(path)) {
    const session = discovery.find((d) => d.threadId === idIn('/v1/threads/'));
    if (!session) return respond(404, { error: 'Discovery has not started on this thread.' });
    const validated = validateDiscoveryAnswers(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    const now = new Date().toISOString();
    for (const [k, answer] of Object.entries(validated.value)) {
      session.answers[k] = { answer, source: 'operator', capturedAt: now };
    }
    session.updatedAt = now;
    logEvent(store, 'discovery.updated', {
      subject_table: 'discovery_sessions',
      subject_id: session.id,
      payload: {
        via: 'web',
        captured: Object.keys(validated.value),
        completeness: discoveryCompleteness(session.answers),
      },
    });
    return respond(200, { session: describeSession(session) });
  }
  if (method === 'POST' && /^\/v1\/threads\/[^/]+\/discovery\/next$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    const session = discovery.find((d) => d.threadId === idIn('/v1/threads/'));
    if (!t || !session) return respond(404, { error: 'Discovery has not started on this thread.' });
    const draft = draftBatch(t, session);
    if (!draft)
      return respond(409, {
        error: 'Every question has been answered; there is nothing left to ask.',
      });
    return respond(201, { session: describeSession(session), draft });
  }
  if (method === 'GET' && /^\/v1\/threads\/[^/]+\/brief$/.test(path)) {
    const rows = briefs
      .filter((b) => b.threadId === idIn('/v1/threads/'))
      .sort((a, b) => b.version - a.version);
    return respond(200, {
      brief: rows[0] ? describeBrief(rows[0]) : null,
      versions: rows.map(versionOf),
    });
  }
  if (method === 'POST' && /^\/v1\/threads\/[^/]+\/brief$/.test(path)) {
    const t = threads.find((row) => row.id === idIn('/v1/threads/'));
    if (!t) return respond(404, { error: 'no such thread' });
    if (briefs.some((b) => b.threadId === t.id))
      return respond(409, {
        error:
          'This thread already has a brief. Edit it, or start a new version from the locked one.',
      });
    const session = discovery.find((d) => d.threadId === t.id);
    const draft = briefFromDiscovery(session?.answers ?? {}, t.jobTitle);
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      threadId: t.id,
      version: 1,
      locked: false,
      lockedAt: null,
      ...draft,
      outcome: draft.outcome || '(not answered yet)',
      createdAt: now,
      updatedAt: now,
    };
    briefs.push(row);
    store.briefs = briefs;
    logEvent(store, 'brief.drafted', {
      subject_table: 'briefs',
      subject_id: row.id,
      payload: { via: 'web', version: 1 },
    });
    return respond(201, { brief: describeBrief(row) });
  }
  if (method === 'GET' && /^\/v1\/briefs\/[^/]+$/.test(path)) {
    const row = briefs.find((b) => b.id === idIn('/v1/briefs/'));
    if (!row) return respond(404, { error: 'no such brief' });
    return respond(200, { brief: describeBrief(row) });
  }
  if (method === 'PUT' && /^\/v1\/briefs\/[^/]+$/.test(path)) {
    const row = briefs.find((b) => b.id === idIn('/v1/briefs/'));
    if (!row) return respond(404, { error: 'no such brief' });
    if (row.locked)
      return respond(409, {
        error: `Version ${String(row.version)} is locked and cannot be changed. Start a new version to change it.`,
      });
    const validated = validateBrief(body);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    Object.assign(row, validated.value, { updatedAt: new Date().toISOString() });
    logEvent(store, 'brief.updated', {
      subject_table: 'briefs',
      subject_id: row.id,
      payload: { via: 'web', version: row.version },
    });
    return respond(200, { brief: describeBrief(row) });
  }
  if (method === 'POST' && /^\/v1\/briefs\/[^/]+\/lock$/.test(path)) {
    const row = briefs.find((b) => b.id === idIn('/v1/briefs/'));
    if (!row) return respond(404, { error: 'no such brief' });
    if (row.locked)
      return respond(409, { error: `Version ${String(row.version)} is already locked.` });
    const missing = briefLockBlockers(/** @type {any} */ (row));
    if (missing.length > 0) {
      return respond(422, {
        error: `The brief cannot lock without ${missing.join(', ')}.`,
        errors: missing.map((what) => ({ field: 'lock', message: `needs ${what}` })),
      });
    }
    row.locked = true;
    row.lockedAt = new Date().toISOString();
    row.updatedAt = row.lockedAt;
    logEvent(store, 'brief.locked', {
      subject_table: 'briefs',
      subject_id: row.id,
      payload: { via: 'web', version: row.version },
    });
    return respond(200, { brief: describeBrief(row) });
  }
  if (method === 'POST' && /^\/v1\/briefs\/[^/]+\/versions$/.test(path)) {
    const from = briefs.find((b) => b.id === idIn('/v1/briefs/'));
    if (!from) return respond(404, { error: 'no such brief' });
    const current = briefs
      .filter((b) => b.threadId === from.threadId)
      .sort((a, b) => b.version - a.version)[0];
    if (current && !current.locked)
      return respond(409, {
        error: `Version ${String(current.version)} is still open. Edit it, or lock it before starting another.`,
      });
    const now = new Date().toISOString();
    const row = {
      ...from,
      id: uuid(),
      version: (current?.version ?? 0) + 1,
      locked: false,
      lockedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    briefs.push(row);
    logEvent(store, 'brief.drafted', {
      subject_table: 'briefs',
      subject_id: row.id,
      payload: { via: 'web', version: row.version, from: `version ${String(from.version)}` },
    });
    return respond(201, { brief: describeBrief(row) });
  }

  if (key === 'GET /v1/proposals') {
    const status = url.searchParams.get('status') ?? 'queued';
    return respond(200, {
      proposals: store.proposals.filter((p) => status === 'all' || p.status === status),
      biddingPaused: store.biddingPaused,
    });
  }
  /** @param {Row} row @param {string} action @param {string} [reason] */
  const decide = (row, action, reason) => {
    if (row.status !== 'queued') return `This bid is ${row.status}.`;
    row.status = action === 'approve' ? 'approved' : 'rejected';
    if (action === 'approve') {
      row.approved_by = USER;
      row.approved_by_name = 'Demo Owner';
      row.approved_via = 'web';
    } else {
      row.failure_reason = reason;
    }
    row.updated_at = new Date().toISOString();
    const j = store.jobs.find((x) => x.id === row.job_id);
    if (j) j.proposal_status = row.status;
    logEvent(store, action === 'approve' ? 'proposal.approved' : 'proposal.rejected', {
      subject_table: 'proposals',
      subject_id: row.id,
      payload: { via: 'web', ...(reason ? { reason } : {}) },
    });
    return null;
  };
  if (key === 'POST /v1/proposals/bulk') {
    const results = /** @type {string[]} */ (body?.ids ?? []).map((id) => {
      const row = store.proposals.find((p) => p.id === id);
      if (!row) return { id, ok: false, error: 'no such bid' };
      const error = decide(row, body.action, body.reason);
      return error ? { id, ok: false, error } : { id, ok: true };
    });
    return respond(200, { results });
  }
  if (method === 'POST' && /^\/v1\/proposals\/[^/]+\/(approve|reject)$/.test(path)) {
    const row = store.proposals.find((p) => p.id === idIn('/v1/proposals/'));
    if (!row) return respond(404, { error: 'no such bid' });
    const action = path.endsWith('/approve') ? 'approve' : 'reject';
    if (action === 'reject' && !String(body?.reason ?? '').trim()) {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'reason', message: 'must not be empty' }],
      });
    }
    const error = decide(row, action, body?.reason);
    if (error) return respond(409, { error });
    return respond(200, {
      proposal: row,
      ...(action === 'approve' ? { biddingPaused: store.biddingPaused, queued: true } : {}),
    });
  }
  if (method === 'PATCH' && /^\/v1\/proposals\/[^/]+$/.test(path)) {
    const row = store.proposals.find((p) => p.id === idIn('/v1/proposals/'));
    if (!row) return respond(404, { error: 'no such bid' });
    if (row.status === 'submitted') return respond(409, { error: 'This bid is submitted.' });
    row.body = String(body?.body ?? row.body);
    row.status = 'queued';
    row.approved_by = null;
    row.approved_by_name = null;
    row.approved_via = null;
    logEvent(store, 'proposal.edited', { subject_table: 'proposals', subject_id: row.id });
    return respond(200, { proposal: row });
  }

  // ARB-121 in the demo: the auto-reply is kept in the tab; nothing is ever sent.
  if (key === 'GET /v1/auto-reply') return respond(200, { autoReply: store.autoReply ?? null });
  if (key === 'PUT /v1/auto-reply') {
    const value = /** @type {Record<string, any>} */ (body ?? {});
    const validated = validateAutoReply(value);
    if (!validated.ok)
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    store.autoReply = {
      id: 'd0d0d0d0-0000-4000-8000-000000000026',
      ...validated.value,
      approvedBy: USER,
      updatedAt: new Date().toISOString(),
    };
    logEvent(store, 'settings.changed', {
      subject_table: 'auto_replies',
      subject_id: store.autoReply.id,
      payload: { via: 'web', changed: ['autoReply'] },
    });
    return respond(200, { autoReply: store.autoReply });
  }

  if (key === 'GET /v1/settings') {
    return respond(200, {
      settings: store.settings,
      liveModeBlockers: blockersOf(store.settings),
      environmentLiveMode: false,
      accounts: store.accounts,
      telegramLinked: store.telegramLinked,
      role: 'owner',
      freelancer: { configured: true, environment: 'demo', reason: null },
      upwork: { configured: true, environment: 'demo', reason: null },
    });
  }
  // ARB-020 in the demo: "connecting" goes straight to the callback page with a sample
  // code, and nothing reaches Freelancer.com.
  if (key === 'POST /v1/platform-accounts/freelancer/connect') {
    store.connectPending = true;
    logEvent(store, 'account.connect_started', { payload: { via: 'web', note: 'demo' } });
    return respond(201, {
      authorizeUrl: './freelancer-callback.html?code=demo-code',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  }
  if (key === 'POST /v1/platform-accounts/freelancer/callback') {
    if (!store.connectPending) {
      return respond(409, {
        error:
          'No connection is waiting for this code, or it is more than ten minutes old. Start again from Settings.',
      });
    }
    store.connectPending = false;
    let account = store.accounts.find((a) => a.platform === 'freelancer');
    if (!account) {
      account = { id: uuid(), platform: 'freelancer', scopes: [], lastSyncAt: null };
      store.accounts.push(account);
    }
    Object.assign(account, {
      externalUserId: 'sample-account',
      externalUsername: 'sample-account (demo)',
      status: 'connected',
      scopes: ['basic', '1', '2', '5', '6'],
    });
    logEvent(store, 'account.connected', {
      subject_table: 'platform_accounts',
      subject_id: account.id,
      payload: { via: 'web', note: 'demo: nothing reached Freelancer.com' },
    });
    return respond(201, { account });
  }
  // ARB-300 in the demo: the same for Upwork, which is used to read jobs only.
  if (key === 'POST /v1/platform-accounts/upwork/connect') {
    store.upworkConnectPending = true;
    logEvent(store, 'account.connect_started', {
      payload: { via: 'web', platform: 'upwork', note: 'demo' },
    });
    return respond(201, {
      authorizeUrl: './upwork-callback.html?code=demo-code',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  }
  if (key === 'POST /v1/platform-accounts/upwork/callback') {
    if (!store.upworkConnectPending) {
      return respond(409, {
        error:
          'No connection is waiting for this code, or it is more than ten minutes old. Start again from Settings.',
      });
    }
    store.upworkConnectPending = false;
    let account = store.accounts.find((a) => a.platform === 'upwork');
    if (!account) {
      account = { id: uuid(), platform: 'upwork', scopes: [], lastSyncAt: null };
      store.accounts.push(account);
    }
    Object.assign(account, {
      externalUserId: 'sample-upwork-account',
      externalUsername: 'Sample Upwork account (demo)',
      status: 'connected',
    });
    logEvent(store, 'account.connected', {
      subject_table: 'platform_accounts',
      subject_id: account.id,
      payload: { via: 'web', platform: 'upwork', note: 'demo: nothing reached Upwork' },
    });
    return respond(201, { account });
  }
  if (method === 'POST' && /^\/v1\/platform-accounts\/[^/]+\/disconnect$/.test(path)) {
    const account = store.accounts.find((a) => a.id === idIn('/v1/platform-accounts/'));
    if (!account) return respond(404, { error: 'no such platform account' });
    account.status = 'disconnected';
    logEvent(store, 'account.disconnected', {
      subject_table: 'platform_accounts',
      subject_id: account.id,
    });
    return respond(200, { account });
  }
  if (key === 'PATCH /v1/settings') {
    const validated = validateMarginRules(body);
    if (!validated.ok) {
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    }
    if (body.feeTable !== undefined) {
      const fees = parseFeeTable(body.feeTable);
      if (!fees.ok) {
        return respond(422, { error: 'the request was not accepted', errors: fees.errors });
      }
      store.settings.feeTable = body.feeTable;
    }
    const fixed = (/** @type {unknown} */ v) =>
      v === null || v === undefined ? null : Number(v).toFixed(3);
    const value = /** @type {Record<string, unknown>} */ (validated.value);
    if ('minMarginPct' in value) store.settings.minMarginPct = fixed(value.minMarginPct);
    if ('minMarginZarMinor' in value)
      store.settings.minMarginZarMinor =
        value.minMarginZarMinor === null ? null : String(value.minMarginZarMinor);
    if ('fxBufferPct' in value) store.settings.fxBufferPct = fixed(value.fxBufferPct);
    if ('vatPct' in value) store.settings.vatPct = fixed(value.vatPct);
    if ('retentionDays' in value) store.settings.retentionDays = value.retentionDays;
    store.settings.updatedAt = new Date().toISOString();
    logEvent(store, 'settings.changed', {
      subject_table: 'settings',
      payload: { via: 'web', changed: Object.keys(value) },
    });
    return respond(200, { settings: store.settings, liveModeBlockers: blockersOf(store.settings) });
  }
  if (key === 'POST /v1/settings/live-mode') {
    const live = body?.live;
    if (typeof live !== 'boolean') {
      return respond(422, {
        error: 'the request was not accepted',
        errors: [{ field: 'live', message: 'must be true or false' }],
      });
    }
    const missing = blockersOf(store.settings);
    if (live && missing.length > 0) {
      return respond(422, {
        error: `Live mode needs ${missing.join(', ')} before it can be switched on.`,
      });
    }
    store.settings.liveMode = live;
    logEvent(store, 'live_mode.changed', {
      subject_table: 'settings',
      payload: { via: 'web', live_after: live, note: 'demo: nothing is sent' },
    });
    return respond(200, { settings: store.settings, liveModeBlockers: missing });
  }
  if (method === 'PATCH' && /^\/v1\/platform-accounts\/[^/]+$/.test(path)) {
    const validated = validatePlanRecord(body);
    if (!validated.ok) {
      return respond(422, { error: 'the request was not accepted', errors: validated.errors });
    }
    const account = store.accounts.find((a) => a.id === idIn('/v1/platform-accounts/'));
    if (!account) return respond(404, { error: 'no such platform account' });
    account.planName = validated.value.planName;
    account.monthlyBidAllowance = validated.value.monthlyBidAllowance;
    account.planRecordedOn = new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10);
    logEvent(store, 'settings.changed', {
      subject_table: 'platform_accounts',
      subject_id: account.id,
      payload: { via: 'web', what: 'plan_recorded' },
    });
    return respond(200, { account });
  }
  if (key === 'GET /v1/price-bands') return respond(200, { categories: 22, bands: [] });

  if (key === 'GET /v1/scanners') return respond(200, { scanners: store.scanners });
  if ((key === 'POST /v1/scanners' || method === 'PATCH') && path.startsWith('/v1/scanners')) {
    const validated = validateScanner(body);
    const errors = validated.ok ? checkAutoSendGuardrails(body) : validated.errors;
    if (errors.length > 0) {
      return respond(422, { error: 'the request was not accepted', errors });
    }
    const fields = {
      name: String(body.name).trim(),
      platform: body.platform,
      filters: body.filters ?? {},
      poll_interval_seconds: body.pollIntervalSeconds ?? 120,
      active: body.active ?? true,
      auto_send: body.autoSend ?? false,
      min_score: body.minScore ?? null,
      daily_cap: body.dailyCap ?? 0,
      updated_at: new Date().toISOString(),
    };
    const editing =
      method === 'PATCH' ? store.scanners.find((s) => s.id === idIn('/v1/scanners/')) : null;
    const clash = store.scanners.find(
      (s) => s.name.toLowerCase() === fields.name.toLowerCase() && s.id !== editing?.id,
    );
    if (clash)
      return respond(409, { error: 'a scanner with that name already exists in this org' });
    if (method === 'PATCH') {
      if (!editing) return respond(404, { error: 'no such scanner' });
      Object.assign(editing, fields);
      logEvent(store, 'scanner.updated', { subject_table: 'scanners', subject_id: editing.id });
      return respond(200, { scanner: editing });
    }
    const row = { id: uuid(), org_id: ORG, created_at: new Date().toISOString(), ...fields };
    store.scanners.push(row);
    logEvent(store, 'scanner.created', {
      subject_table: 'scanners',
      subject_id: row.id,
      payload: { via: 'web', name: row.name },
    });
    return respond(201, { scanner: row });
  }
  if (method === 'DELETE' && path.startsWith('/v1/scanners/')) {
    const index = store.scanners.findIndex((s) => s.id === idIn('/v1/scanners/'));
    if (index < 0) return respond(404, { error: 'no such scanner' });
    const gone = /** @type {Row} */ (store.scanners.splice(index, 1)[0]);
    logEvent(store, 'scanner.deleted', { subject_table: 'scanners', subject_id: gone.id });
    return respond(204, null);
  }

  if (key === 'POST /v1/telegram/link-codes') {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.charAt(b % 32),
    ).join('');
    return respond(201, { code, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  }

  if (key === 'GET /v1/events/actors') {
    return respond(200, { actors: [{ id: USER, name: 'Demo Owner', email: 'demo@example.com' }] });
  }
  if (key === 'GET /v1/events.csv') {
    const rows = filteredEvents(store, url);
    const header =
      'date_sast,created_at_utc,type,outcome,actor_kind,actor_user_id,subject_table,subject_id,request_id,payload,id';
    const lines = rows.map((e) =>
      [
        sast(e.created_at),
        e.created_at,
        e.type,
        e.outcome,
        e.actor_kind,
        e.actor_user_id,
        e.subject_table,
        e.subject_id,
        e.request_id,
        JSON.stringify(e.payload),
        e.id,
      ]
        .map(csvCell)
        .join(','),
    );
    save(store);
    return new Response([header, ...lines].join('\r\n') + '\r\n', {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="audit-log-demo.csv"',
        'x-export-rows': String(rows.length),
        'x-export-truncated': 'false',
      },
    });
  }
  if (key === 'GET /v1/events') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return respond(200, {
      events: filteredEvents(store, url).slice(offset, offset + limit),
      page: { limit, offset },
    });
  }

  return respond(404, { error: `the demo has no ${method} ${path}` });
}

/** Supabase Auth, as far as the pages use it: the password grant, the user, sign-out. */
/** @param {string} method @param {URL} url @param {any} body */
function auth(method, url, body) {
  if (method === 'POST' && url.pathname === '/auth/v1/token') {
    if (!body?.email || !body?.password) {
      return json(400, {
        code: 400,
        error_code: 'validation_failed',
        msg: 'missing email or password',
      });
    }
    return json(200, {
      access_token: 'demo-access-token',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'demo-refresh-token',
      user: { id: USER, email: String(body.email) },
    });
  }
  // ARB-400: sign-up answers as a project that asks for email confirmation does — the
  // user, no session — so the demo never pretends an account was made.
  if (method === 'POST' && url.pathname === '/auth/v1/signup') {
    return json(200, {
      id: uuid(),
      aud: 'authenticated',
      email: String(body?.email ?? ''),
      email_confirmed_at: null,
    });
  }
  if (method === 'POST' && url.pathname === '/auth/v1/logout') return json(204, null);
  if (method === 'GET' && url.pathname === '/auth/v1/user') return json(200, { id: USER });
  return json(404, { msg: 'not in the demo' });
}

// ------------------------------------------------------------------ the patch
const realFetch = window.fetch.bind(window);

window.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), location.href);
  if (url.origin !== API_ORIGIN && url.origin !== AUTH_ORIGIN) return realFetch(input, init);
  const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
  let body = null;
  const raw = init.body ?? null;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  // A short pause, so loading states show as they would against a real server.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return url.origin === API_ORIGIN ? api(method, url, body) : auth(method, url, body);
};

// A signed-in page opened directly gets the sample person's session, so every page can
// be viewed from its own link. The login and sign-up pages are left alone so they can be
// seen too.
const page = location.pathname.split('/').pop() || 'index.html';
if (!['login.html', 'signup.html'].includes(page) && !sessionStorage.getItem(SESSION_KEY)) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      access_token: 'demo-access-token',
      refresh_token: 'demo-refresh-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: USER, email: 'demo@example.com' },
    }),
  );
}

// ------------------------------------------------------------------ the banner
function banner() {
  const style = document.createElement('style');
  style.textContent = `
    .demo-banner { background: var(--color-warning, #b58100); color: #111; padding: 8px 16px;
      font-size: 0.875rem; line-height: 1.5; text-align: center; }
    .demo-banner button { margin-left: 8px; font: inherit; text-decoration: underline;
      background: none; border: 0; color: inherit; cursor: pointer; padding: 0; }
  `;
  const note = document.createElement('div');
  note.className = 'demo-banner';
  note.setAttribute('role', 'note');
  note.id = 'demo-banner';
  note.append(
    'Demo mode: sample data only. Nothing is saved to a server or sent to a marketplace, and no figure is a real price, fee or client.',
  );
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.id = 'demo-reset';
  reset.textContent = 'Reset the sample data';
  reset.addEventListener('click', () => {
    sessionStorage.removeItem(STORE_KEY);
    location.reload();
  });
  note.append(reset);
  document.head.append(style);
  document.body.prepend(note);
}

if (document.body) banner();
else document.addEventListener('DOMContentLoaded', banner);
