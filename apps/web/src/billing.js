// @ts-check
import { PLAN_METRIC_LABELS } from '@arbitron/core';
import { apiGet, apiSend } from './lib/api.js';
import { formatDate, formatMoney } from './lib/format.js';
import { backToLoginOn401, mountShell } from './lib/shell.js';
import { runAction } from './lib/ui.js';

/**
 * Billing (ARB-420). `GET /v1/billing`: the plans on sale, with a price per currency and
 * the provider that takes it, and where this organisation stands. An owner's Pay button
 * asks `POST /v1/billing/checkout` for the provider's own checkout page and goes there;
 * the plan starts when the provider's webhook confirms the payment, not when the browser
 * comes back. Nothing about a card is entered or kept here.
 */

/**
 * @typedef {{ currency: 'ZAR' | 'USD', provider: 'paystack' | 'stripe', amountMinor: number }} Price
 * @typedef {{ code: string, name: string, limits: Record<string, number | null>, prices: Price[] }} PlanRow
 * @typedef {{ configured: boolean, environment: string | null, reason: string | null }} Provider
 * @typedef {{ role: string, houseOrg: boolean,
 *   state: { kind: 'exempt' } | { kind: 'plan', plan: { name: string }, status: string } | { kind: 'none', message: string } | null,
 *   subscription: { plan: string, status: string, provider: string | null, currency: string | null, graceUntil: string | null } | null,
 *   plans: PlanRow[], graceDays: number | null,
 *   providers: { paystack: Provider, stripe: Provider } }} Billing
 */

/** @param {string} id */
function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`billing is missing #${id}`);
  return element;
}

const status = byId('status');
const state = byId('billing-state');
const grace = byId('billing-grace');
const plansGrid = byId('plans');
const plansEmpty = byId('plans-empty');

const PROVIDER_NAME = { paystack: 'Paystack', stripe: 'Stripe' };
/** @type {Record<string, string>} */
const STATUS_WORDS = {
  trialing: 'on trial',
  active: 'active',
  past_due: 'a payment has failed',
  cancelled: 'ended',
};

/** @param {Billing} billing */
function renderState(billing) {
  grace.hidden = true;
  if (billing.houseOrg) {
    state.textContent =
      'This is the house organisation: it is not billed, and every metered action is counted without a limit.';
    return;
  }
  const sub = billing.subscription;
  if (billing.state?.kind === 'plan' && sub) {
    const via =
      sub.provider === 'paystack' || sub.provider === 'stripe'
        ? PROVIDER_NAME[sub.provider]
        : 'the provider';
    state.textContent = `Plan: ${billing.state.plan.name}, ${STATUS_WORDS[sub.status] ?? sub.status}, paid through ${via}.`;
    if (sub.status === 'past_due') {
      grace.hidden = false;
      grace.textContent = sub.graceUntil
        ? `The plan keeps working until ${formatDate(sub.graceUntil)}. Pay what is owed with ${via} before then to keep it.`
        : `Pay what is owed with ${via} to keep the plan. No grace period is set, so it keeps working until ${via} ends the subscription.`;
    }
    return;
  }
  state.textContent =
    billing.state?.kind === 'none'
      ? billing.state.message
      : 'This organisation has no plan yet. Choose one below.';
}

/**
 * @param {PlanRow} plan
 * @param {Billing} billing
 */
function planCard(plan, billing) {
  const card = document.createElement('article');
  card.className = 'card stack';
  card.dataset.plan = plan.code;
  const heading = document.createElement('h3');
  heading.textContent = plan.name;
  const limits = document.createElement('ul');
  for (const [metric, label] of Object.entries(PLAN_METRIC_LABELS)) {
    const item = document.createElement('li');
    const limit = plan.limits[metric];
    item.textContent = `${label}: ${limit === null || limit === undefined ? 'no limit' : `${String(limit)} a month`}`;
    limits.append(item);
  }
  const actions = document.createElement('div');
  actions.className = 'cluster';
  const hasPlan =
    billing.subscription !== null &&
    ['active', 'past_due', 'trialing'].includes(billing.subscription.status);
  for (const price of plan.prices) {
    const provider = billing.providers[price.provider];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--primary';
    button.textContent = `Pay ${formatMoney(BigInt(price.amountMinor), price.currency)} with ${PROVIDER_NAME[price.provider]}`;
    const why = billing.houseOrg
      ? 'The house organisation is not billed.'
      : billing.role !== 'owner'
        ? 'Only an owner can choose or pay for the plan.'
        : hasPlan
          ? 'This organisation already has a plan.'
          : !provider.configured
            ? (provider.reason ?? `${PROVIDER_NAME[price.provider]} is not set up.`)
            : null;
    if (why) {
      button.disabled = true;
      button.title = why;
    }
    button.addEventListener('click', () => {
      void runAction(
        button,
        status,
        async () => {
          try {
            const result = /** @type {{ url: string }} */ (
              await apiSend('POST', '/v1/billing/checkout', {
                plan: plan.code,
                currency: price.currency,
              })
            );
            location.assign(result.url);
            return `Opening ${PROVIDER_NAME[price.provider]}…`;
          } catch (error) {
            if (backToLoginOn401(error)) return '';
            throw error;
          }
        },
        { success: (message) => message },
      );
    });
    actions.append(button);
  }
  if (plan.prices.length === 0) {
    const note = document.createElement('p');
    note.className = 'section-note';
    note.textContent = 'No price is published for this plan yet.';
    actions.append(note);
  }
  card.append(heading, limits, actions);
  return card;
}

/** What the provider's return to this page means: the webhook, not the browser, decides. */
function returnNote() {
  const checkout = new URLSearchParams(location.search).get('checkout');
  if (!checkout) return null;
  history.replaceState(null, '', location.pathname);
  return checkout === 'cancelled'
    ? 'The checkout was cancelled. Nothing was charged.'
    : 'Thank you. The plan starts as soon as the payment provider confirms the payment; reload this page to see it.';
}

async function load() {
  const note = returnNote();
  await runAction(
    /** @type {HTMLButtonElement} */ (document.createElement('button')),
    status,
    async () => {
      try {
        const billing = /** @type {Billing} */ (await apiGet('/v1/billing'));
        renderState(billing);
        plansGrid.replaceChildren(...billing.plans.map((plan) => planCard(plan, billing)));
        plansEmpty.hidden = billing.plans.length > 0;
        return note ?? 'Billing loaded.';
      } catch (error) {
        if (backToLoginOn401(error)) return '';
        throw error;
      }
    },
    { success: (message) => message },
  );
}

void mountShell().then((me) => {
  if (me) void load();
});
