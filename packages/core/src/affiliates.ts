import type { FieldError, ValidationResult } from './scanners.js';

/**
 * Affiliates (ARB-430, docs/01 section D: `affiliates`, `attribution`). The house org's
 * owner (D-069) gives an affiliate a referral code; a visit with `?ref=<code>` is recorded
 * as a click; an org created in that browser after the click is attributed to it; and the
 * org's first paid plan (ARB-420) marks the click converted. The commission is the
 * owner's figure, recorded as given and never defaulted; paying it out is not built
 * (D-071).
 */
export const REFERRAL_CODE = /^[A-Za-z0-9-]{3,40}$/;

/** The query parameter a referral link carries: `https://…/?ref=<code>`. */
export const REFERRAL_PARAM = 'ref';

export function isReferralCode(value: unknown): value is string {
  return typeof value === 'string' && REFERRAL_CODE.test(value);
}

export interface NewAffiliate {
  readonly code: string;
  readonly ownerEmail: string | null;
  /** Per cent of what a referred org pays, as the owner agreed it; null until agreed. */
  readonly commissionPct: string | null;
}

export function validateAffiliate(input: unknown): ValidationResult<NewAffiliate> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'body', message: 'must be an object' }] };
  }
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code) errors.push({ field: 'code', message: 'is required' });
  else if (!REFERRAL_CODE.test(code)) {
    errors.push({
      field: 'code',
      message: 'must be 3 to 40 letters, digits or hyphens, so it reads cleanly in a link',
    });
  }

  let ownerEmail: string | null = null;
  if (body.ownerEmail !== undefined && body.ownerEmail !== null && body.ownerEmail !== '') {
    const email = typeof body.ownerEmail === 'string' ? body.ownerEmail.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ field: 'ownerEmail', message: 'must be an email address' });
    } else {
      ownerEmail = email;
    }
  }

  let commissionPct: string | null = null;
  const raw = body.commissionPct;
  if (raw !== undefined && raw !== null && raw !== '') {
    const text =
      typeof raw === 'number'
        ? String(raw)
        : typeof raw === 'string'
          ? raw.trim().replace(',', '.')
          : '';
    if (!/^\d{1,3}(\.\d{1,3})?$/.test(text) || Number(text) > 100) {
      errors.push({
        field: 'commissionPct',
        message: 'must be a percentage from 0 to 100, up to three decimals, or left empty',
      });
    } else {
      commissionPct = Number(text).toFixed(3);
    }
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: { code, ownerEmail, commissionPct } };
}

/** One affiliate's funnel, as the owner's report shows it. */
export interface AffiliateFunnel {
  readonly clicks: number;
  /** Clicks followed by an org created in that browser. */
  readonly signUps: number;
  /** Of those orgs, the ones whose first plan was paid. */
  readonly paid: number;
}

/** Whole per cent, rounded down; null with nothing under it. */
export function funnelRate(part: number, whole: number): number | null {
  return whole > 0 ? Math.floor((part * 100) / whole) : null;
}
