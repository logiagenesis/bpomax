import type { FieldError, ValidationResult } from './scanners.js';

/**
 * Public sign-up (ARB-400): the form a new person fills in to create their organisation,
 * and the first steps the onboarding page lists once they have.
 *
 * The database holds the same rule (`app.create_org`, migration 0032); this is the copy
 * the API and the pages check first, so a mistake is named against its field.
 */
export const ORG_NAME_MAX = 100;

export interface NewOrg {
  readonly name: string;
  /** ISO 3166-1 alpha-2, upper case. */
  readonly countryCode: string;
}

export function validateNewOrg(input: unknown): ValidationResult<NewOrg> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'body', message: 'must be an object' }] };
  }
  const body = input as Record<string, unknown>;
  const errors: FieldError[] = [];

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (typeof body.name !== 'string' || name.length === 0) {
    errors.push({ field: 'name', message: 'is required' });
  } else if (name.length > ORG_NAME_MAX) {
    errors.push({ field: 'name', message: `must be at most ${String(ORG_NAME_MAX)} characters` });
  }

  const rawCountry = body.countryCode ?? 'ZA';
  const countryCode = typeof rawCountry === 'string' ? rawCountry.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    errors.push({
      field: 'countryCode',
      message: 'must be a two-letter ISO 3166-1 code, such as ZA',
    });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { name, countryCode } };
}

/** What the onboarding page needs to know about an org to say what is left to do. */
export interface OnboardingFacts {
  readonly marginRulesSet: boolean;
  readonly freelancerConnected: boolean;
  readonly scannerCount: number;
  readonly activeTemplateCount: number;
  readonly telegramLinked: boolean;
}

export type OnboardingStepKey =
  'org' | 'margin' | 'freelancer' | 'scanner' | 'template' | 'telegram';

export interface OnboardingStep {
  readonly key: OnboardingStepKey;
  readonly title: string;
  /** Why it matters, in one sentence. */
  readonly detail: string;
  /** The page, and the heading on it, where the step is done. */
  readonly href: string;
  readonly done: boolean;
  /** Only the Telegram step is optional: the web queue approves everything it does. */
  readonly optional: boolean;
}

/**
 * The first steps, in the order they unblock each other: nothing is judged without the
 * margin rules, nothing is found without an account and a saved search, and nothing is
 * drafted without a template. Each step is read from the org's own rows, never ticked by
 * hand.
 */
export function onboardingSteps(facts: OnboardingFacts): readonly OnboardingStep[] {
  return [
    {
      key: 'org',
      title: 'Create your organisation',
      detail: 'Everything you add is kept inside it, and only its members can see it.',
      href: 'settings.html',
      done: true,
      optional: false,
    },
    {
      key: 'margin',
      title: 'Set your margin rules and fee table',
      detail:
        'No job is priced until the minimum margin, the FX buffer and the platform fees are set.',
      href: 'settings.html#rules-heading',
      done: facts.marginRulesSet,
      optional: false,
    },
    {
      key: 'freelancer',
      title: 'Connect Freelancer.com',
      detail: 'Jobs are found and bids are sent through your own connected account.',
      href: 'settings.html#accounts-heading',
      done: facts.freelancerConnected,
      optional: false,
    },
    {
      key: 'scanner',
      title: 'Add a saved search',
      detail: 'A scanner decides which new jobs are pulled in, and how often.',
      href: 'settings.html#scanners-heading',
      done: facts.scannerCount > 0,
      optional: false,
    },
    {
      key: 'template',
      title: 'Add a bid template',
      detail: 'Drafts are written from your active templates, in your own words.',
      href: 'templates.html',
      done: facts.activeTemplateCount > 0,
      optional: false,
    },
    {
      key: 'telegram',
      title: 'Link Telegram',
      detail: 'Approve bids and messages from your phone. The web queue does the same.',
      href: 'settings.html#telegram-heading',
      done: facts.telegramLinked,
      optional: true,
    },
  ];
}
