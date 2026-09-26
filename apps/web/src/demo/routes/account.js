// @ts-check
/** The demo's account routes (D-043), split out of demo.js (ARB-531). */
import { onboardingSteps, validateAffiliate } from '@arbitron/core';
import { logEvent, me, monthStart, templatesOf } from '../shared.js';
import { USER, proposalFor, uuid } from '../store.js';
/** @typedef {import('../store.js').Row} Row */

/**
 * @param {import('../context.js').Context} ctx
 * @returns {Response | undefined}
 */
export function accountRoutes(ctx) {
  const { method, url, body, store, path, key, idIn, respond } = ctx;
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
  // ARB-430 in the demo: the sample org runs the programme; clicks are counted in the tab.
  if (key === 'POST /v1/referrals/clicks') {
    const found = (store.affiliates ?? []).find((a) => a.code === body?.code && a.active);
    if (!found) return respond(404, { error: 'That referral code is not in use.' });
    found.clicks += 1;
    found.lastClickAt = new Date().toISOString();
    return respond(201, { clickId: uuid() });
  }
  if (key === 'GET /v1/affiliates') {
    return respond(200, { affiliates: store.affiliates ?? [] });
  }
  if (key === 'POST /v1/affiliates') {
    const parsed = validateAffiliate(body ?? {});
    if (!parsed.ok)
      return respond(422, { error: 'the request was not accepted', errors: parsed.errors });
    store.affiliates = store.affiliates ?? [];
    if (store.affiliates.some((a) => a.code.toLowerCase() === parsed.value.code.toLowerCase())) {
      return respond(409, { error: 'That code is already in use. Choose another.' });
    }
    const affiliate = {
      id: uuid(),
      ...parsed.value,
      active: true,
      createdAt: new Date().toISOString(),
      clicks: 0,
      signUps: 0,
      paid: 0,
      lastClickAt: null,
    };
    store.affiliates.push(affiliate);
    return respond(201, { affiliate });
  }
  if (method === 'PATCH' && path.startsWith('/v1/affiliates/')) {
    const affiliate = (store.affiliates ?? []).find((a) => a.id === idIn('/v1/affiliates/'));
    if (!affiliate) return respond(404, { error: 'no such affiliate' });
    affiliate.active = Boolean(body?.active);
    return respond(200, { ok: true });
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
  return undefined;
}
