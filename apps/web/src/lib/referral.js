// @ts-check
import { REFERRAL_PARAM, isReferralCode } from '@arbitron/core';
import { apiBaseUrl } from './api.js';

/**
 * Referral links (ARB-430, D-071). A visit with `?ref=<code>` is recorded once by the API
 * as a click, and the click's id (not the code, and nothing about the visitor) is kept in
 * this browser, so an organisation created here later is attributed to it. The last
 * referral link followed is the one kept. A referral never gets in the way of the page:
 * any failure is ignored.
 */
export const REFERRAL_KEY = 'arbitron.referral';

/** @returns {string | null} the click id this browser kept */
export function readReferral() {
  try {
    const raw = localStorage.getItem(REFERRAL_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return typeof parsed?.clickId === 'string' ? parsed.clickId : null;
  } catch {
    return null;
  }
}

export function clearReferral() {
  try {
    localStorage.removeItem(REFERRAL_KEY);
  } catch {
    /* nothing kept */
  }
}

/**
 * Records the click if the address carries a referral code, keeps its id, and takes the
 * code out of the address so a reload or a shared link does not count it twice.
 * @param {string} landingPage e.g. "index.html"
 * @param {typeof fetch} [doFetch]
 */
export async function captureReferral(landingPage, doFetch = fetch) {
  const url = new URL(location.href);
  const code = url.searchParams.get(REFERRAL_PARAM);
  if (code === null) return;
  url.searchParams.delete(REFERRAL_PARAM);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  if (!isReferralCode(code)) return;
  try {
    const response = await doFetch(`${apiBaseUrl()}/v1/referrals/clicks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, landingPage }),
    });
    if (!response.ok) return;
    const body = await response.json();
    if (typeof body?.clickId === 'string') {
      localStorage.setItem(
        REFERRAL_KEY,
        JSON.stringify({ clickId: body.clickId, at: new Date().toISOString() }),
      );
    }
  } catch {
    /* a referral never gets in the way */
  }
}
