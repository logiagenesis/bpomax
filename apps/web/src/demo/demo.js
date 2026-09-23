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
  checkAutoSendGuardrails,
  liveModeBlockers,
  parseFeeTable,
  validateMarginRules,
  validatePlanRecord,
  validateScanner,
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
 *   events: Row[] }} Store
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

  return {
    version: 1,
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
      retainers: [{ currency: 'ZAR', amountMinor: '450000', count: 1 }],
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

  if (key === 'GET /v1/settings') {
    return respond(200, {
      settings: store.settings,
      liveModeBlockers: blockersOf(store.settings),
      environmentLiveMode: false,
      accounts: store.accounts,
      telegramLinked: store.telegramLinked,
      role: 'owner',
    });
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
// be viewed from its own link. The login page is left alone so it can be seen too.
const page = location.pathname.split('/').pop() || 'index.html';
if (page !== 'login.html' && !sessionStorage.getItem(SESSION_KEY)) {
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
