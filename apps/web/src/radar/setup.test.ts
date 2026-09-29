import { describe, expect, it } from 'vitest';
import type { StoredToken } from './account.js';
import { exportNote, setupItems } from './setup.js';
import { DEFAULT_SETTINGS, type Settings } from './store.js';

/**
 * The setup line and the export reminder (LI-PROMPT-BPOMAX-FIX-20260929, U-01 and U-02),
 * worked by hand. NOW is 29/09/2026 10:00 SAST.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-29T08:00:00Z');
const KEEP = 'What you save here stays only in this browser: press Export to keep a copy.';

describe('the export reminder (U-02)', () => {
  it('says Never exported, and warns only when there is something to keep', () => {
    expect(exportNote(null, NOW, false)).toEqual({
      text: 'Never exported',
      stale: false,
      warning: null,
    });
    expect(exportNote(null, NOW, true)).toEqual({
      text: 'Never exported',
      stale: true,
      warning: `You have not exported yet. ${KEEP}`,
    });
  });

  it('gives the date of the last export in DD/MM/YYYY, in SAST', () => {
    expect(exportNote(NOW - 2 * DAY, NOW, true).text).toBe('Last export: 27/09/2026');
    // 23:30 UTC on 21/09 is 01:30 SAST on 22/09.
    expect(exportNote(Date.parse('2026-09-21T23:30:00Z'), NOW, true).text).toBe(
      'Last export: 22/09/2026',
    );
  });

  it('does not warn up to 7 days, and warns after: 7 days is fine, 7 days and 1 ms is not', () => {
    expect(exportNote(NOW - 7 * DAY, NOW, true)).toMatchObject({ stale: false, warning: null });
    const late = exportNote(NOW - 7 * DAY - 1, NOW, true);
    expect(late.stale).toBe(true);
    expect(late.warning).toBe(`Your last export was 7 days ago (22/09/2026). ${KEEP}`);
  });

  it('counts whole days in the warning: 9 days and 5 hours ago is 9 days', () => {
    const note = exportNote(NOW - 9 * DAY - 5 * 60 * 60 * 1000, NOW, false);
    // 03:00 UTC on 20/09 is 05:00 SAST on 20/09. It warns whether or not anything is saved.
    expect(note.warning).toBe(`Your last export was 9 days ago (20/09/2026). ${KEEP}`);
  });

  it('counts a clock set back, an export dated in the future, as fresh', () => {
    expect(exportNote(NOW + DAY, NOW, true)).toMatchObject({ stale: false, warning: null });
  });
});

const account = {
  id: 1234567,
  username: 'example-user',
  role: 'freelancer',
  limited: false,
  membership: 'plus',
  bidLimit: 100,
  bidPeriod: 'month',
};
const token = (over: Partial<StoredToken> = {}): StoredToken => ({
  token: 'e2e-token-abcdefghijklmnopqrstuvwxyz-7Q9Z',
  savedAt: NOW - DAY,
  account,
  checkedAt: NOW - DAY,
  problem: null,
  ...over,
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  ...over,
});
const asPairs = (items: ReturnType<typeof setupItems>) =>
  items.map((item) => [item.label, item.state, item.text]);

describe('the setup line (U-01)', () => {
  it('on a fresh browser shows all eight items as not set, in order', () => {
    const items = setupItems(
      { settings: settings(), templates: [], stored: null, lastExport: null, hasData: false },
      NOW,
    );
    expect(asPairs(items)).toEqual([
      ['Skills', 'unset', 'not set'],
      ['In-house ticks', 'unset', 'not set'],
      ['Template', 'unset', 'not set'],
      ['Monthly limit', 'unset', 'not set'],
      ['Fee %', 'unset', 'not set'],
      ['USD→ZAR', 'unset', 'not set'],
      ['Token', 'unset', 'not saved'],
      ['Last export', 'unset', 'never'],
    ]);
  });

  it('shows each as set once it is: skills, in-house, a template, limit, fee, rate, token, export', () => {
    const items = setupItems(
      {
        settings: settings({
          skills: [{ id: 3, name: 'PHP' }],
          inHouse: [{ id: 3, name: 'PHP' }],
          monthlyLimit: 100,
          feePct: 10,
          usdToZar: 16.5,
        }),
        templates: [{}],
        stored: token(),
        lastExport: NOW - 2 * DAY,
        hasData: true,
      },
      NOW,
    );
    expect(asPairs(items)).toEqual([
      ['Skills', 'set', 'set'],
      ['In-house ticks', 'set', 'set'],
      ['Template', 'set', 'set'],
      ['Monthly limit', 'set', 'set'],
      ['Fee %', 'set', 'set'],
      ['USD→ZAR', 'set', 'set'],
      ['Token', 'set', 'saved'],
      ['Last export', 'set', '27/09/2026'],
    ]);
  });

  it('counts a fee of 0 % as set: only blank is not set', () => {
    const items = setupItems(
      {
        settings: settings({ feePct: 0 }),
        templates: [],
        stored: null,
        lastExport: null,
        hasData: false,
      },
      NOW,
    );
    expect(items.find((item) => item.key === 'fee')?.state).toBe('set');
  });

  describe('the token', () => {
    const tokenOf = (stored: StoredToken | null) =>
      setupItems(
        { settings: settings(), templates: [], stored, lastExport: null, hasData: false },
        NOW,
      ).find((item) => item.key === 'token');

    it('is saved with 6 days left, and expiring with 5', () => {
      // A token lasts 30 days. Saved 24 days ago: 6 left, fine. Saved 25 days ago: 5 left.
      expect(tokenOf(token({ savedAt: NOW - 24 * DAY }))).toMatchObject({
        state: 'set',
        text: 'saved',
      });
      expect(tokenOf(token({ savedAt: NOW - 25 * DAY }))).toMatchObject({
        state: 'warn',
        text: 'expiring',
      });
    });

    it('has expired after 30 days', () => {
      expect(tokenOf(token({ savedAt: NOW - 31 * DAY }))).toMatchObject({
        state: 'warn',
        text: 'expired',
      });
    });

    it('is refused when Freelancer.com refused it at the last check', () => {
      expect(tokenOf(token({ problem: 'Token rejected (HTTP 401).' }))).toMatchObject({
        state: 'warn',
        text: 'refused',
      });
    });

    it('is not checked when there is no account behind it', () => {
      expect(tokenOf(token({ account: null }))).toMatchObject({
        state: 'warn',
        text: 'not checked',
      });
    });
  });

  it('marks the last export as needing attention after 7 days', () => {
    const at = (lastExport: number) =>
      setupItems(
        { settings: settings(), templates: [], stored: null, lastExport, hasData: true },
        NOW,
      ).find((item) => item.key === 'export');
    expect(at(NOW - 7 * DAY)).toMatchObject({ state: 'set', text: '22/09/2026' });
    expect(at(NOW - 8 * DAY)).toMatchObject({ state: 'warn', text: '21/09/2026' });
  });
});
