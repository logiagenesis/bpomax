import { readFileSync } from 'node:fs';
import { parseTermsOfService } from '@arbitron/core';
import type { PublishedTerms } from '@arbitron/db';

/**
 * The terms of service the web app shows (ARB-522): `apps/web/src/public/terms.json`,
 * the owner's (D-16, D-068). The API reads the same file when it starts, so the version
 * `app.create_org` holds a new owner to is the one the page asked them to accept.
 */
export const TERMS_FILE = new URL('../../web/src/public/terms.json', import.meta.url);

export type TermsOnShow =
  | { readonly status: 'approved'; readonly terms: PublishedTerms }
  | { readonly status: 'pending' }
  | { readonly status: 'unreadable'; readonly reason: string };

export function readTermsOnShow(
  read: () => string = () => readFileSync(TERMS_FILE, 'utf8'),
): TermsOnShow {
  let raw: unknown;
  try {
    raw = JSON.parse(read());
  } catch (error) {
    return {
      status: 'unreadable',
      reason: `the terms file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = parseTermsOfService(raw);
  if (!parsed.ok) {
    return {
      status: 'unreadable',
      reason: `the terms file is not valid: ${parsed.errors.map((e) => `${e.field} ${e.message}`).join('; ')}`,
    };
  }
  if (parsed.value.status !== 'approved') return { status: 'pending' };
  return {
    status: 'approved',
    terms: { version: parsed.value.version, approvedOn: parsed.value.approvedOn },
  };
}
