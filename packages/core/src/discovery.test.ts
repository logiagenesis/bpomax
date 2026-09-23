import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_QUESTIONS,
  acceptedDiscoveryAnswers,
  discoveryCompleteness,
  mergeDiscoveryAnswers,
  nextDiscoveryBatch,
  renderDiscoveryBatch,
  validateDiscoveryAnswers,
} from './discovery.js';

const AT = new Date('2026-09-23T10:00:00Z');

describe('the question set', () => {
  it('is section F’s ten questions, in its order', () => {
    expect(DISCOVERY_QUESTIONS).toHaveLength(10);
    expect(DISCOVERY_QUESTIONS[0]?.text).toBe('What is the end result you need, in one sentence?');
    expect(DISCOVERY_QUESTIONS[9]?.text).toBe('Who signs off, and how fast can they respond?');
    expect(new Set(DISCOVERY_QUESTIONS.map((q) => q.key)).size).toBe(10);
  });
});

describe('completeness and batches', () => {
  it('completeness is answered over ten, to two decimals', () => {
    expect(discoveryCompleteness({})).toBe(0);
    const three = mergeDiscoveryAnswers(
      {},
      { outcome: 'A shop', users: 'Customers', tech: 'Shopify' },
      'client',
      AT,
    );
    // Hand-worked: 3 of 10 is 30,00 %.
    expect(discoveryCompleteness(three)).toBe(30);
    const all = mergeDiscoveryAnswers(
      {},
      Object.fromEntries(DISCOVERY_QUESTIONS.map((q) => [q.key, 'x'])),
      'operator',
      AT,
    );
    expect(discoveryCompleteness(all)).toBe(100);
  });

  it('a batch is the open questions never asked first, three at a time, and never the whole set', () => {
    expect(nextDiscoveryBatch({}, {}).map((q) => q.key)).toEqual(['outcome', 'users', 'day_one']);
    const asked = { outcome: AT.toISOString(), users: AT.toISOString(), day_one: AT.toISOString() };
    const answers = mergeDiscoveryAnswers({}, { outcome: 'A shop' }, 'client', AT);
    // users and day_one were asked and not answered: they come after the never-asked ones.
    expect(nextDiscoveryBatch(answers, asked).map((q) => q.key)).toEqual([
      'references',
      'assets',
      'tech',
    ]);
    expect(nextDiscoveryBatch(answers, asked, 100)).toHaveLength(9);
    expect(nextDiscoveryBatch({}, {}, 100).length).toBeLessThan(DISCOVERY_QUESTIONS.length);
    expect(
      nextDiscoveryBatch(
        mergeDiscoveryAnswers(
          {},
          Object.fromEntries(DISCOVERY_QUESTIONS.map((q) => [q.key, 'x'])),
          'client',
          AT,
        ),
        {},
      ),
    ).toEqual([]);
  });

  it('renders the batch as a numbered draft with no invented facts', () => {
    const text = renderDiscoveryBatch(nextDiscoveryBatch({}, {}), 'acme-shop');
    expect(text).toBe(
      [
        'Hi acme-shop, thanks for your message. A few questions so I can scope this properly:',
        '',
        '1. What is the end result you need, in one sentence?',
        '2. Who uses it (you, your staff, your customers)?',
        '3. What must it do on day one? What can wait?',
        '',
        'Short answers are fine.',
      ].join('\n'),
    );
    expect(renderDiscoveryBatch([], null)).toContain('Hi, thanks');
  });
});

describe('answers', () => {
  it('validates keys and text', () => {
    expect(
      validateDiscoveryAnswers({ answers: { outcome: ' A shop ', budget: 'R20 000, fixed' } }),
    ).toEqual({
      ok: true,
      value: { outcome: 'A shop', budget: 'R20 000, fixed' },
    });
    const bad = validateDiscoveryAnswers({ answers: { nope: 'x', users: '' } });
    expect(!bad.ok && bad.errors.map((e) => e.field)).toEqual(['answers.nope', 'answers.users']);
    expect(validateDiscoveryAnswers({ answers: {} })).toMatchObject({ ok: false });
    expect(validateDiscoveryAnswers({})).toMatchObject({ ok: false });
  });

  it('accepts only confident readings of still-open questions', () => {
    const answers = mergeDiscoveryAnswers({}, { outcome: 'A shop' }, 'operator', AT);
    const accepted = acceptedDiscoveryAnswers(
      {
        answers: [
          { key: 'outcome', answer: 'Something else', confidence: 0.99 },
          { key: 'users', answer: 'Our customers', confidence: 0.9 },
          { key: 'tech', answer: 'Maybe Shopify', confidence: 0.4 },
          { key: 'budget', answer: '   ', confidence: 0.9 },
        ],
      },
      answers,
    );
    expect(accepted).toEqual({ users: 'Our customers' });
    const merged = mergeDiscoveryAnswers(answers, accepted, 'client', AT);
    expect(merged.users).toEqual({
      answer: 'Our customers',
      source: 'client',
      capturedAt: AT.toISOString(),
    });
    expect(merged.outcome?.source).toBe('operator');
  });
});
