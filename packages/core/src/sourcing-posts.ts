import type { BriefInput } from './brief.js';
import type { FieldError, ValidationResult } from './scanners.js';

/**
 * Sourcing post drafts (ARB-202, docs/01 section E: the sourcing worker "drafts
 * sourcing post(s) for approval"). A post asks suppliers to quote for the work, so it
 * carries the brief's scope and nothing that could lead back to the client: no handle,
 * no sign-off name, no public job title or id, no email address, phone number, link or
 * web domain. The client's budget is never copied into a post either, because a
 * supplier who sees it can price against it; the operator sets the post's budget.
 *
 * Freelancer.com posts go through the API after approval (ARB-203). Upwork and Fiverr
 * have no verified buyer API (docs/01 section B), so their drafts are copied by hand.
 */
export const SOURCING_POST_PLATFORMS = ['freelancer', 'upwork', 'fiverr'] as const;
export type SourcingPostPlatform = (typeof SOURCING_POST_PLATFORMS)[number];
/** Platforms whose posts are made by a person, outside the app, and recorded here. */
export const MANUAL_POST_PLATFORMS: readonly SourcingPostPlatform[] = ['upwork', 'fiverr'];

export const MAX_SOURCING_POST_TITLE = 120;
export const MAX_SOURCING_POST_BODY = 6000;

export type SourcingPostState = 'draft' | 'approved' | 'posted' | 'closed' | 'failed';

/** What the scrubber looks for besides the generic patterns. */
export interface ClientIdentifiers {
  readonly clientHandle: string | null;
  readonly signOffName: string | null;
  /** The client's public job title: a post that repeats it can be traced back to the job. */
  readonly jobTitle: string | null;
  readonly jobExternalId: string | null;
}

export interface SourcingPostDraft {
  readonly title: string;
  readonly body: string;
}

/** The brief fields a post may use: scope only. Title, sign-off and budget are left out on purpose. */
export type BriefScope = Pick<
  BriefInput,
  | 'outcome'
  | 'users'
  | 'mustHaves'
  | 'later'
  | 'references'
  | 'assetsProvided'
  | 'assetsMissing'
  | 'techConstraints'
  | 'deadline'
  | 'deadlineFixed'
  | 'acceptanceCriteria'
>;

function isoToSast(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}

function list(heading: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  return ['', heading, ...items.map((item) => `- ${item}`)];
}

/** The first sentence of the outcome, cut to the title's length at a word boundary. */
function titleFrom(outcome: string, categoryName: string): string {
  const first = (outcome.split(/(?<=[.!?])\s/)[0] ?? outcome).replace(/[.!?]+$/, '').trim();
  const base = first.length > 0 ? `${categoryName}: ${first}` : categoryName;
  if (base.length <= MAX_SOURCING_POST_TITLE) return base;
  const cut = base.slice(0, MAX_SOURCING_POST_TITLE - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : cut.length)}…`;
}

/**
 * The draft, from the brief's scope. The same words for every platform: the operator
 * edits a draft for a platform's conventions before approving it.
 */
export function buildSourcingPost(
  brief: BriefScope,
  options: { readonly categoryName: string },
): SourcingPostDraft {
  const lines: string[] = [brief.outcome.trim()];
  if (brief.users) lines.push('', `Who uses it: ${brief.users.trim()}`);
  lines.push(...list('Must have:', brief.mustHaves));
  lines.push(...list('Can wait for a later phase:', brief.later));
  lines.push(...list('Technology:', brief.techConstraints));
  lines.push(...list('Already available:', brief.assetsProvided));
  lines.push(...list('Still needed:', brief.assetsMissing));
  lines.push(...list('Finished when:', brief.acceptanceCriteria));
  if (brief.references.length > 0) {
    lines.push(
      '',
      `Reference examples: ${String(brief.references.length)}, shared with the supplier chosen.`,
    );
  }
  if (brief.deadline) {
    const kind =
      brief.deadlineFixed === true
        ? ' (fixed)'
        : brief.deadlineFixed === false
          ? ' (flexible)'
          : '';
    lines.push('', `Deadline: ${isoToSast(brief.deadline)}${kind}`);
  }
  lines.push('', 'Please quote a fixed price and a turnaround in days.');
  return { title: titleFrom(brief.outcome, options.categoryName), body: lines.join('\n') };
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** Seven or more digits, allowing spaces, dots, dashes and brackets between them, with an optional +. */
const PHONE = /(?:\+|\b)\d(?:[\s().-]*\d){6,}\b/;
const LINK = /\b(?:https?:\/\/|www\.)\S+/i;
/**
 * A bare web domain. The endings are the common generic ones and South Africa's; a
 * framework name such as Next.js does not match because `.js` is not an ending here.
 */
const DOMAIN =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|dev|app|shop|store|online|site|info|biz|za|co\.za|org\.za|uk|co\.uk)\b/i;

function contains(text: string, needle: string | null, min: number): boolean {
  if (!needle) return false;
  const n = needle.trim().toLowerCase();
  return n.length >= min && text.toLowerCase().includes(n);
}

/**
 * Every reason the draft could identify the client, by field. Empty when it is clean.
 * Run on every draft and every edit, in the API and on the page.
 */
export function clientIdentifyingProblems(
  draft: SourcingPostDraft,
  who: ClientIdentifiers,
): FieldError[] {
  const errors: FieldError[] = [];
  for (const field of ['title', 'body'] as const) {
    const text = draft[field];
    const add = (message: string) => errors.push({ field, message });
    if (contains(text, who.clientHandle, 3)) add('contains the client’s handle');
    if (contains(text, who.signOffName, 3))
      add('contains the name of the client’s sign-off person');
    if (contains(text, who.jobTitle, 12)) add('repeats the client’s public job title');
    if (contains(text, who.jobExternalId, 5)) add('contains the client’s job number');
    if (EMAIL.test(text)) add('contains an email address');
    // The job number is reported as itself, not again as a phone number.
    const jobId = who.jobExternalId?.trim();
    const withoutJob = jobId ? text.split(jobId).join(' ') : text;
    if (PHONE.test(withoutJob)) add('contains a phone number');
    if (LINK.test(text)) add('contains a link');
    // An email's own domain is reported as the email address, not again as a web address.
    else if (DOMAIN.test(text.replace(new RegExp(EMAIL.source, 'gi'), ' ')))
      add('contains a web address');
  }
  return errors;
}

export interface SourcingPostEdit {
  readonly title: string;
  readonly body: string;
  /** Whole minor units, or null when the post names no budget. */
  readonly budgetMinMinor: number | null;
  readonly budgetMaxMinor: number | null;
  readonly currency: string | null;
}

function minor(errors: FieldError[], field: string, value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    errors.push({ field, message: 'must be a whole number of cents, zero or more' });
    return null;
  }
  return value;
}

/** A person's edit: the text within its limits and a budget that holds together. */
export function validateSourcingPostEdit(input: unknown): ValidationResult<SourcingPostEdit> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '', message: 'must be an object' }] };
  }
  const raw = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (title === '') errors.push({ field: 'title', message: 'must not be empty' });
  else if (title.length > MAX_SOURCING_POST_TITLE)
    errors.push({
      field: 'title',
      message: `must be ${String(MAX_SOURCING_POST_TITLE)} characters or fewer`,
    });
  if (body === '') errors.push({ field: 'body', message: 'must not be empty' });
  else if (body.length > MAX_SOURCING_POST_BODY)
    errors.push({
      field: 'body',
      message: `must be ${String(MAX_SOURCING_POST_BODY)} characters or fewer`,
    });
  const budgetMinMinor = minor(errors, 'budgetMinMinor', raw.budgetMinMinor);
  const budgetMaxMinor = minor(errors, 'budgetMaxMinor', raw.budgetMaxMinor);
  const currencyRaw = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  const currency = currencyRaw === '' ? null : currencyRaw;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency))
    errors.push({ field: 'currency', message: 'must be a three-letter currency code such as ZAR' });
  if ((budgetMinMinor !== null || budgetMaxMinor !== null) && currency === null)
    errors.push({ field: 'currency', message: 'is needed when the post names a budget' });
  if (budgetMinMinor !== null && budgetMaxMinor !== null && budgetMinMinor > budgetMaxMinor)
    errors.push({ field: 'budgetMaxMinor', message: 'must not be below the lower figure' });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { title, body, budgetMinMinor, budgetMaxMinor, currency } };
}
