/**
 * Job scoring (ARB-032, docs/01 sections A and E).
 *
 * The model judges fit, client quality and competition, and returns JSON matching
 * `SCORE_SCHEMA`. Red flags are not left to the model alone: the ones that can be seen
 * in the text — a request to talk or pay off the platform, an upfront fee, unpaid test
 * work — are also detected by rules here, and a rule's finding cannot be argued away by
 * a confident reply. A missed scam is the expensive mistake; a false alarm costs the
 * operator one glance.
 */
export const SCORE_VERDICTS = ['go', 'caution', 'skip'] as const;
export type ScoreVerdict = (typeof SCORE_VERDICTS)[number];

export const RED_FLAGS = [
  'off_platform_payment',
  'upfront_fee',
  'crypto_payment',
  'credentials_request',
  'academic_dishonesty',
  'off_platform_contact',
  'unpaid_test_work',
  'payment_unverified',
  'vague_scope',
  'unrealistic_budget',
] as const;
export type RedFlag = (typeof RED_FLAGS)[number];

/**
 * Flags that make a job a skip whatever else is true of it. Each is either a known
 * marketplace scam pattern or grounds for the account to be suspended.
 */
export const HARD_FLAGS: readonly RedFlag[] = [
  'off_platform_payment',
  'upfront_fee',
  'crypto_payment',
  'credentials_request',
  'academic_dishonesty',
];

/** A skipped job never scores above this, so the number and the verdict agree. */
export const SKIP_SCORE_CEILING = 20;

export interface ModelScore {
  readonly score: number;
  readonly verdict: ScoreVerdict;
  readonly reasons: string[];
  readonly flags: RedFlag[];
  readonly reply_probability: number;
}

export const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'verdict', 'reasons', 'flags', 'reply_probability'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string', enum: [...SCORE_VERDICTS] },
    reasons: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: { type: 'string', minLength: 3, maxLength: 240 },
    },
    flags: { type: 'array', uniqueItems: true, items: { type: 'string', enum: [...RED_FLAGS] } },
    reply_probability: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

/** The fields of a `jobs` row that scoring reads. Budgets are in minor units. */
export interface ScorableJob {
  readonly title: string;
  readonly description: string | null;
  readonly budgetMinMinor: number | null;
  readonly budgetMaxMinor: number | null;
  readonly currency: string | null;
  readonly hourly: boolean;
  readonly skills: readonly string[];
  readonly clientCountry: string | null;
  readonly clientPaymentVerified: boolean | null;
  readonly clientSpendMinor: number | null;
  readonly clientRating: number | null;
  readonly bidCount: number | null;
  readonly averageBidMinor: number | null;
}

interface Rule {
  readonly flag: RedFlag;
  readonly why: string;
  readonly test: (job: ScorableJob, text: string) => boolean;
}

const RULES: readonly Rule[] = [
  {
    flag: 'off_platform_payment',
    why: 'asks to be paid or to pay outside the platform',
    test: (_, text) =>
      /\b(western union|moneygram|wire (it|the money) directly)\b/.test(text) ||
      /\b(pay|paid|payment)\b[^.]{0,40}\b(outside|off)\s+(of\s+)?(the\s+)?(site|platform|freelancer|upwork)\b/.test(
        text,
      ) ||
      /\b(pay|paid|payment)\b[^.]{0,30}\b(via|by|through|over)\s+(paypal|cash ?app|zelle|venmo|bank transfer)\b/.test(
        text,
      ),
  },
  {
    flag: 'upfront_fee',
    why: 'asks the freelancer to pay first',
    test: (_, text) =>
      /\b(registration|joining|onboarding|training|activation|membership)\s+fee\b/.test(text) ||
      /\b(security )?deposit\b[^.]{0,40}\b(before|to start|to begin|refundable)\b/.test(text) ||
      /\byou (will )?(need to|must) (pay|buy|purchase)\b/.test(text),
  },
  {
    flag: 'crypto_payment',
    why: 'offers payment in cryptocurrency',
    test: (_, text) =>
      /\b(paid|pay|payment)\b[^.]{0,30}\b(usdt|bitcoin|btc|crypto(currency)?|ethereum|eth)\b/.test(
        text,
      ),
  },
  {
    flag: 'credentials_request',
    why: 'wants account logins, ID documents or a verified account handed over',
    test: (_, text) =>
      /\b(rent|lend|share|use) (your|an?) (verified )?(account|profile)\b/.test(text) ||
      /\b(send|share|provide) (me )?(your )?(password|login details|id card|passport|bank login)\b/.test(
        text,
      ),
  },
  {
    flag: 'academic_dishonesty',
    why: 'asks for graded academic work to be done for someone',
    test: (_, text) =>
      /\b(take|do|write|complete) my (online )?(exam|test|quiz|assignment|homework|thesis|dissertation|coursework)\b/.test(
        text,
      ),
  },
  {
    flag: 'off_platform_contact',
    why: 'asks to move the conversation off the platform',
    test: (_, text) =>
      /\b(whatsapp|telegram|skype|wechat|signal|discord)\b/.test(text) ||
      /\b[\w.+-]+@(gmail|yahoo|outlook|hotmail|proton(mail)?)\.[a-z]{2,}\b/.test(text) ||
      /\b(email|text|call) me (at|on)\b/.test(text),
  },
  {
    flag: 'unpaid_test_work',
    why: 'asks for free sample or trial work',
    test: (_, text) =>
      /\b(free|unpaid) (sample|test|trial|mock ?up|demo)\b/.test(text) ||
      /\b(sample|test task|trial)\b[^.]{0,30}\b(unpaid|for free|without pay(ment)?)\b/.test(text),
  },
  {
    flag: 'payment_unverified',
    why: 'the client has not verified a payment method',
    test: (job) => job.clientPaymentVerified === false,
  },
];

export interface RuleFinding {
  readonly flag: RedFlag;
  readonly why: string;
}

/** Red flags visible in the job itself, without asking a model. */
export function detectRedFlags(job: ScorableJob): RuleFinding[] {
  const text = `${job.title}\n${job.description ?? ''}`.toLowerCase();
  return RULES.filter((rule) => rule.test(job, text)).map(({ flag, why }) => ({ flag, why }));
}

export interface FinalScore extends ModelScore {
  /** Flags the rules raised that the model did not. Kept so the gap can be measured. */
  readonly ruleOnlyFlags: RedFlag[];
}

/**
 * Combines the model's judgement with the rules. The rules can only make a verdict
 * worse: any hard flag is a skip with the score capped, and any other flag turns a
 * `go` into a `caution`.
 */
export function reconcileScore(model: ModelScore, findings: readonly RuleFinding[]): FinalScore {
  const modelFlags = new Set(model.flags);
  const ruleOnly = findings.filter((finding) => !modelFlags.has(finding.flag));
  const all = new Set<RedFlag>([...model.flags, ...findings.map((finding) => finding.flag)]);
  const flags = RED_FLAGS.filter((flag) => all.has(flag));

  let verdict = model.verdict;
  let score = model.score;
  if (flags.some((flag) => HARD_FLAGS.includes(flag))) {
    verdict = 'skip';
    score = Math.min(score, SKIP_SCORE_CEILING);
  } else if (flags.length > 0 && verdict === 'go') {
    verdict = 'caution';
  }

  return {
    score,
    verdict,
    flags,
    reply_probability: verdict === 'skip' ? 0 : model.reply_probability,
    reasons: [
      ...model.reasons,
      ...ruleOnly.map((finding) => `Rule check: ${finding.why} (${finding.flag}).`),
    ],
    ruleOnlyFlags: ruleOnly.map((finding) => finding.flag),
  };
}

function money(minor: number | null, currency: string | null): string {
  if (minor === null) return 'not stated';
  return `${(minor / 100).toFixed(2)} ${currency ?? ''}`.trim();
}

export const SCORE_SYSTEM_PROMPT =
  'You qualify freelance marketplace jobs for a small South African digital agency that ' +
  'builds websites, web and mobile apps, automations and design work, and sources ' +
  'specialists for the rest. Judge fit, client quality, competition and red flags. ' +
  'Be sceptical: a vague brief, an unverified client or a budget far below the work is ' +
  'a reason to lower the score. Reply with JSON only.';

/**
 * The scoring prompt. It carries the job and the client's platform statistics, never a
 * client's name or handle: those are not needed to judge the work.
 */
export function buildScorePrompt(job: ScorableJob): string {
  const budget =
    job.budgetMinMinor === null && job.budgetMaxMinor === null
      ? 'not stated'
      : `${money(job.budgetMinMinor, job.currency)} to ${money(job.budgetMaxMinor, job.currency)}${job.hourly ? ' per hour' : ' fixed'}`;
  const lines = [
    `Title: ${job.title}`,
    `Description:\n${job.description ?? '(none)'}`,
    `Budget: ${budget}`,
    `Skills: ${job.skills.length > 0 ? job.skills.join(', ') : 'none listed'}`,
    `Client country: ${job.clientCountry ?? 'unknown'}`,
    `Client payment verified: ${job.clientPaymentVerified === null ? 'unknown' : job.clientPaymentVerified ? 'yes' : 'no'}`,
    `Client lifetime spend: ${money(job.clientSpendMinor, job.currency)}`,
    `Client rating: ${job.clientRating ?? 'none'}`,
    `Bids so far: ${job.bidCount ?? 'unknown'}; average bid: ${money(job.averageBidMinor, job.currency)}`,
  ];
  return [
    'Score this job from 0 to 100 and give a verdict: go (bid), caution (bid only if the ' +
      'price is right) or skip.',
    '',
    ...lines,
    '',
    'Return a JSON object with exactly these keys:',
    '- score: integer 0-100',
    '- verdict: "go" | "caution" | "skip"',
    '- reasons: 1 to 6 short sentences, the most important first',
    `- flags: any of ${RED_FLAGS.map((flag) => `"${flag}"`).join(', ')}; empty if none`,
    '- reply_probability: 0 to 1, the chance a well-priced bid gets a reply',
  ].join('\n');
}
