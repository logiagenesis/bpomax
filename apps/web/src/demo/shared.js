// @ts-check
/**
 * What the demo's routes share (D-043): responses, the sample person, the audit log,
 * and the figures several pages read. Split out of demo.js (ARB-531).
 */
import {
  liveModeBlockers,
  evaluateMargin,
  feeOn,
  findFeeRule,
  parseFeeTable,
  templateFigures,
  variantFigures,
  variantWordsLocked,
} from '@arbitron/core';
import { ORG, USER, ago, event, uuid } from './store.js';
/** @typedef {import('./store.js').Row} Row */
/** @typedef {import('./store.js').Store} Store */

// ----------------------------------------------------------------- responses
/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
export function json(status, body, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const DEMO_CATEGORIES = [
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
export function categoryName(slug) {
  return slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** A CSV file as the API serves one, with the headers the page reads. @param {string} body @param {string} filename @param {number | null} rows */
export function csvFile(body, filename, rows) {
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
export function me(store) {
  return {
    user: {
      id: USER,
      email: 'demo@example.com',
      fullName: 'Demo Owner',
      telegramLinked: store.telegramLinked,
    },
    org: {
      id: ORG,
      name: 'Logi-Ink (demo)',
      baseCurrency: 'ZAR',
      vatPct: store.settings?.vatPct ?? '15.000',
    },
    role: 'owner',
  };
}

/** @param {Row} settings */
export function blockersOf(settings) {
  return liveModeBlockers({
    minMarginPct: settings.minMarginPct,
    minMarginZarMinor: settings.minMarginZarMinor,
    fxBufferPct: settings.fxBufferPct,
    feeTableLength: settings.feeTable.length,
    retentionDays: settings.retentionDays,
  });
}

/** @param {Store} store @param {string} type @param {Row} [partial] */
export function logEvent(store, type, partial = {}) {
  store.events.unshift(
    event(type, { actor_kind: 'user', actor_user_id: USER, payload: { via: 'web' }, ...partial }),
  );
}

/**
 * Whether a sent bid had a client message on its job's conversation at or after it went:
 * the reply rule of analytics and templates (D-061, D-064).
 * @param {Store} store @param {Row} p
 */
export function repliedAfter(store, p) {
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
export function templatesOf(store) {
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
export function templateView(store, t) {
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
export function demoReprice(settings, j, c) {
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
export function sast(date) {
  const d = new Date(new Date(date).getTime() + 2 * 3_600_000);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** @param {unknown} value */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {Store} store @param {URL} url @returns {Row[]} */
export function filteredEvents(store, url) {
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

export function monthStart() {
  const now = new Date(Date.now() + 2 * 3_600_000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 2 * 3_600_000);
}
