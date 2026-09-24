import { parsePrivacyNotice, type PrivacyNotice } from './privacy.js';

/**
 * The terms of service a new person accepts at sign-up (ARB-400, D-068).
 *
 * Like the privacy notice, the wording is the owner's, settled with a legal adviser, and
 * none is written here (docs/01 rule 6). It is published in the same shape, at
 * `apps/web/src/public/terms.json`, and held to the same rule: `pending` with no wording,
 * or `approved` naming who approved it and when. Public sign-up stays closed while the
 * terms are pending, because nobody can accept terms that do not exist yet.
 */
export type TermsOfService = PrivacyNotice;

export function parseTermsOfService(input: unknown): ReturnType<typeof parsePrivacyNotice> {
  return parsePrivacyNotice(input);
}
