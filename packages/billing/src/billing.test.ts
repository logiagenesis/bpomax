import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { billingConfig } from './config.js';
import { createFakePaystack, createFakeStripe } from './fake.js';
import {
  fetchPaystackSubscription,
  initializePaystackCheckout,
  verifyPaystackSignature,
  verifyPaystackTransaction,
} from './paystack.js';
import { createStripeCheckout, verifyStripeSignature } from './stripe.js';

/** ARB-420: the provider clients against their stand-ins, and the signature checks. */
const ENV = {
  APP_URL: 'http://localhost:5173',
  PAYSTACK_SECRET_KEY: 'sk_stand_in_paystack',
  STRIPE_SECRET_KEY: 'sk_test_stand_in',
  STRIPE_WEBHOOK_SECRET: 'whsec_stand_in',
  PAYSTACK_BASE_URL: 'https://paystack.stand-in.test',
  STRIPE_BASE_URL: 'https://stripe.stand-in.test',
};

describe('billingConfig', () => {
  it('names what is missing, and B-15', () => {
    const config = billingConfig({});
    expect(config.paystack).toMatchObject({ ok: false });
    if (!config.paystack.ok) expect(config.paystack.reason).toMatch(/PAYSTACK_SECRET_KEY.*B-15/);
    if (!config.stripe.ok) {
      expect(config.stripe.reason).toMatch(
        /STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not set.*B-15/,
      );
    }
  });

  it('uses the documented hosts unless a stand-in is named, and says which', () => {
    const real = billingConfig({ ...ENV, PAYSTACK_BASE_URL: '', STRIPE_BASE_URL: '' });
    expect(real.paystack).toMatchObject({
      ok: true,
      config: { baseUrl: 'https://api.paystack.co', environment: 'unknown' },
    });
    expect(real.stripe).toMatchObject({
      ok: true,
      config: { baseUrl: 'https://api.stripe.com', environment: 'test' },
    });
    const live = billingConfig({ ...ENV, STRIPE_BASE_URL: '', STRIPE_SECRET_KEY: 'sk_live_x' });
    expect(live.stripe).toMatchObject({ ok: true, config: { environment: 'live' } });
    const standIn = billingConfig(ENV);
    expect(standIn.stripe).toMatchObject({ config: { environment: 'stand-in' } });
    expect(standIn.returnUrl).toBe('http://localhost:5173/billing.html');
    // A base URL on the real host is the real host, not a stand-in.
    expect(
      billingConfig({ ...ENV, STRIPE_BASE_URL: 'https://api.stripe.com' }).stripe,
    ).toMatchObject({ config: { environment: 'test' } });
  });
});

describe('Paystack', () => {
  const fake = createFakePaystack();
  const config = billingConfig(ENV).paystack;
  if (!config.ok) throw new Error('config');

  it('starts a checkout with the plan code, the amount in cents and our reference', async () => {
    const result = await initializePaystackCheckout(
      config.config,
      {
        email: 'owner@example.test',
        planCode: 'PLN_test',
        amountMinor: 49_900,
        reference: 'arb-1',
        callbackUrl: 'http://localhost:5173/billing.html?checkout=arb-1',
        metadata: { checkoutId: 'arb-1' },
      },
      fake.fetch,
    );
    expect(result).toEqual({
      authorizationUrl: 'https://paystack.stand-in.test/checkout/arb-1',
      reference: 'arb-1',
    });
    expect(fake.initialized[0]).toEqual({
      email: 'owner@example.test',
      amount: '49900',
      currency: 'ZAR',
      plan: 'PLN_test',
      reference: 'arb-1',
      callback_url: 'http://localhost:5173/billing.html?checkout=arb-1',
      metadata: '{"checkoutId":"arb-1"}',
    });
  });

  it('reads a transaction and a subscription back as Paystack states them', async () => {
    const paid = fake.pay('arb-1');
    expect(await verifyPaystackTransaction(config.config, 'arb-1', fake.fetch)).toEqual({
      status: 'success',
      reference: 'arb-1',
      amountMinor: 49_900,
      currency: 'ZAR',
      customerCode: paid.customerCode,
    });
    expect(
      await fetchPaystackSubscription(config.config, paid.subscriptionCode, fake.fetch),
    ).toEqual({
      subscriptionCode: paid.subscriptionCode,
      status: 'active',
      customerCode: paid.customerCode,
      planCode: 'PLN_test',
    });
  });

  it('reports a refusal with Paystack s message and never the key', async () => {
    const wrong = { ...config.config, secretKey: 'sk_wrong' };
    await expect(verifyPaystackTransaction(wrong, 'arb-1', fake.fetch)).rejects.toThrow(
      'Paystack refused to confirm a payment (HTTP 401: Invalid key).',
    );
    await expect(verifyPaystackTransaction(wrong, 'arb-1', fake.fetch)).rejects.not.toThrow(
      /sk_wrong/,
    );
  });

  it('checks the signature the documented way, over the raw body', () => {
    const body = '{"event":"charge.success","data":{"reference":"arb-1"}}';
    const header = createHmac('sha512', 'sk_stand_in_paystack').update(body).digest('hex');
    expect(verifyPaystackSignature(body, header, 'sk_stand_in_paystack')).toBe(true);
    expect(verifyPaystackSignature(`${body} `, header, 'sk_stand_in_paystack')).toBe(false);
    expect(verifyPaystackSignature(body, header, 'another-key')).toBe(false);
    expect(verifyPaystackSignature(body, undefined, 'sk_stand_in_paystack')).toBe(false);
    expect(verifyPaystackSignature(body, 'short', 'sk_stand_in_paystack')).toBe(false);
  });
});

describe('Stripe', () => {
  const fake = createFakeStripe();
  const config = billingConfig(ENV).stripe;
  if (!config.ok) throw new Error('config');

  it('starts a subscription checkout, form-encoded, and hands back the url', async () => {
    const session = await createStripeCheckout(
      config.config,
      {
        priceId: 'price_test',
        successUrl: 'http://localhost:5173/billing.html?checkout=done',
        cancelUrl: 'http://localhost:5173/billing.html?checkout=cancelled',
        clientReferenceId: 'checkout-1',
        customerEmail: 'owner@example.test',
        metadata: { checkout_id: 'checkout-1' },
      },
      fake.fetch,
    );
    expect(session.url).toBe(`https://stripe.stand-in.test/pay/${session.id}`);
    expect(Object.fromEntries(fake.created[0]!)).toEqual({
      mode: 'subscription',
      'line_items[0][price]': 'price_test',
      'line_items[0][quantity]': '1',
      success_url: 'http://localhost:5173/billing.html?checkout=done',
      cancel_url: 'http://localhost:5173/billing.html?checkout=cancelled',
      client_reference_id: 'checkout-1',
      customer_email: 'owner@example.test',
      'metadata[checkout_id]': 'checkout-1',
    });
  });

  it('refuses with Stripe s message', async () => {
    await expect(
      createStripeCheckout(
        { ...config.config, secretKey: 'sk_test_wrong' },
        {
          priceId: 'price_test',
          successUrl: 'x',
          cancelUrl: 'y',
          clientReferenceId: 'z',
          customerEmail: null,
          metadata: {},
        },
        fake.fetch,
      ),
    ).rejects.toThrow('Stripe refused to start a checkout (HTTP 401: Invalid API Key provided).');
  });

  describe('the signature, checked by the manual steps', () => {
    const body = '{"id":"evt_1","type":"checkout.session.completed"}';
    const now = 1_790_000_000;

    it('accepts the right one, spaces after the commas included', () => {
      const header = fake.sign(body, now).replace(',', ', ');
      expect(verifyStripeSignature(body, header, 'whsec_stand_in', now)).toEqual({
        ok: true,
        timestamp: now,
      });
    });

    it('accepts any matching v1 among several, and ignores v0', () => {
      const good = fake.sign(body, now).split(',v1=')[1];
      const header = `t=${String(now)},v0=abc,v1=${'0'.repeat(64)},v1=${good!}`;
      expect(verifyStripeSignature(body, header, 'whsec_stand_in', now).ok).toBe(true);
    });

    it.each([
      ['a changed body', `${body} `, fake.sign(body, now), now, 'no_match'],
      ['another secret', body, fake.sign(body, now, 'whsec_other'), now, 'no_match'],
      ['no header', body, undefined, now, 'no_header'],
      ['no v1', body, `t=${String(now)},v0=abc`, now, 'no_header'],
      ['a timestamp over 5 minutes old', body, fake.sign(body, now - 301), now, 'too_old'],
    ])('refuses %s', (_label, raw, header, at, reason) => {
      expect(verifyStripeSignature(raw, header, 'whsec_stand_in', at)).toEqual({
        ok: false,
        reason,
      });
    });

    it('accepts one at exactly 5 minutes', () => {
      expect(
        verifyStripeSignature(body, fake.sign(body, now - 300), 'whsec_stand_in', now).ok,
      ).toBe(true);
    });
  });
});
