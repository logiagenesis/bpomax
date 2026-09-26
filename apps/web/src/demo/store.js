// @ts-check
/**
 * The demo's sample data and the tab's copy of it (D-043): the sample org, person and
 * rows, loaded from and saved to sessionStorage. Split out of demo.js (ARB-531).
 */
import { rankSuppliers } from '@arbitron/core';

export const STORE_KEY = 'arbitron.demo';
export const SESSION_KEY = 'arbitron.session';

/** @typedef {Record<string, any>} Row */
/**
 * @typedef {{ version: number, telegramLinked: boolean, biddingPaused: boolean,
 *   settings: Row, accounts: Row[], scanners: Row[], jobs: Row[], proposals: Row[],
 *   events: Row[], affiliates?: Row[], connectPending?: boolean, autoReply?: Row | null, outbound?: Row[],
 *   threads?: Row[], inbound?: Row[], discovery?: Row[], briefs?: Row[], suppliers?: Row[],
 *   sourcing?: Row[], posts?: Row[], pipeline?: Row[], orders?: Row[], payments?: Row[],
 *   templates?: Row[], upworkConnectPending?: boolean }} Store
 */

export const ORG = 'd0d0d0d0-0000-4000-8000-000000000001';
export const USER = 'd0d0d0d0-0000-4000-8000-000000000002';

/**
 * Days before now, as an ISO string.
 * @param {number} days
 * @param {number} [hours]
 */
export function ago(days, hours = 0) {
  return new Date(Date.now() - (days * 24 + hours) * 3_600_000).toISOString();
}

export function uuid() {
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
export function proposalFor(j, partial) {
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
export function event(type, partial = {}) {
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
export function load() {
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
export function save(store) {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* the demo still works for this page */
  }
}
