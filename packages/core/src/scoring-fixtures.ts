import type { RedFlag, ScorableJob } from './scoring.js';

/**
 * Twenty jobs for ARB-032's acceptance test. Written for this repository, not copied from
 * any marketplace; the red-flag ones follow patterns marketplaces warn freelancers about.
 * `ruleFlags` is what the rules must find — exactly that, no more.
 */
export interface ScoringFixture {
  readonly key: string;
  readonly job: ScorableJob;
  readonly ruleFlags: readonly RedFlag[];
}

const base: ScorableJob = {
  title: '',
  description: null,
  budgetMinMinor: 50_000,
  budgetMaxMinor: 150_000,
  currency: 'USD',
  hourly: false,
  skills: [],
  clientCountry: 'GB',
  clientPaymentVerified: true,
  clientSpendMinor: 1_200_000,
  clientRating: 4.8,
  bidCount: 12,
  averageBidMinor: 90_000,
};

function job(fields: Partial<ScorableJob>): ScorableJob {
  return { ...base, ...fields };
}

export const SCORING_FIXTURES: readonly ScoringFixture[] = [
  {
    key: 'clean-wordpress-rebuild',
    job: job({
      title: 'Rebuild our WordPress site in Elementor',
      description:
        'We run a 12-page brochure site for a dental practice. Rebuild it in Elementor Pro, keep the content, improve mobile layout and page speed.',
      skills: ['WordPress', 'Elementor', 'PHP'],
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-shopify-theme',
    job: job({
      title: 'Shopify theme customisation for a candle shop',
      description:
        'Adjust our Dawn theme: new product page layout, bundle discount block, and a size guide pop-up. Figma file provided.',
      skills: ['Shopify', 'Liquid', 'CSS'],
      clientCountry: 'US',
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-landing-page',
    job: job({
      title: 'Landing page for a SaaS launch',
      description:
        'One long-form landing page with pricing table, FAQ and a waitlist form wired to Mailchimp. Copy is written.',
      skills: ['HTML', 'Tailwind', 'Mailchimp'],
      budgetMinMinor: 30_000,
      budgetMaxMinor: 60_000,
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-react-dashboard',
    job: job({
      title: 'React dashboard for warehouse stock levels',
      description:
        'Build a React front end over our existing REST API: stock table, filters, CSV export, and a chart of weekly movements. Auth is already in place.',
      skills: ['React', 'TypeScript', 'REST'],
      budgetMinMinor: 200_000,
      budgetMaxMinor: 400_000,
      clientCountry: 'DE',
      currency: 'EUR',
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-zapier-automation',
    job: job({
      title: 'Automate invoice follow-ups between Xero and HubSpot',
      description:
        'When an invoice in Xero is 7 days overdue, create a HubSpot task for the account owner. Prefer Make or Zapier.',
      skills: ['Zapier', 'Make', 'Xero', 'HubSpot'],
      hourly: true,
      budgetMinMinor: 2_500,
      budgetMaxMinor: 4_000,
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-logo',
    job: job({
      title: 'Logo and brand colours for a bakery',
      description:
        'Looking for a simple, warm logo with two alternative marks and a small colour palette. Three rounds of revisions.',
      skills: ['Logo Design', 'Illustrator'],
      budgetMinMinor: 15_000,
      budgetMaxMinor: 30_000,
      clientCountry: 'ZA',
      currency: 'USD',
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-mobile-app',
    job: job({
      title: 'Flutter app for booking gym classes',
      description:
        'iOS and Android app: timetable, booking, cancellations and push reminders, against our Firebase back end.',
      skills: ['Flutter', 'Firebase'],
      budgetMinMinor: 500_000,
      budgetMaxMinor: 800_000,
      clientCountry: 'AU',
      currency: 'AUD',
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-seo-audit',
    job: job({
      title: 'Technical SEO audit for an e-commerce site',
      description:
        'Crawl, report on indexation, Core Web Vitals and structured data, and a prioritised fix list. About 2,000 URLs.',
      skills: ['SEO', 'Screaming Frog'],
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-api-integration',
    job: job({
      title: 'Connect our booking system to Google Calendar',
      description:
        'Two-way sync between our Laravel booking app and staff Google Calendars using the Calendar API and webhooks.',
      skills: ['Laravel', 'Google Calendar API'],
    }),
    ruleFlags: [],
  },
  {
    key: 'clean-chatbot',
    job: job({
      title: 'Customer support chatbot trained on our help centre',
      description:
        'Embed a chatbot on our site that answers from our 150 help articles and hands off to a human in Zendesk.',
      skills: ['AI', 'Zendesk', 'JavaScript'],
      budgetMinMinor: 100_000,
      budgetMaxMinor: 300_000,
    }),
    ruleFlags: [],
  },
  {
    key: 'vague-no-budget',
    job: job({
      title: 'Need website',
      description: 'Need a website like amazon. Tell me price.',
      budgetMinMinor: null,
      budgetMaxMinor: null,
      currency: null,
      clientSpendMinor: 0,
      clientRating: null,
      bidCount: 48,
    }),
    ruleFlags: [],
  },
  {
    key: 'crowded-cheap-data-entry',
    job: job({
      title: 'Copy 500 product names into a spreadsheet',
      description: 'Simple copy and paste from our old catalogue PDF into Google Sheets.',
      skills: ['Data Entry'],
      budgetMinMinor: 1_000,
      budgetMaxMinor: 2_000,
      bidCount: 95,
      averageBidMinor: 1_500,
    }),
    ruleFlags: [],
  },
  {
    key: 'flag-whatsapp',
    job: job({
      title: 'Website developer needed urgently',
      description:
        'Need a quick business website. Message me on WhatsApp +1 555 0100 to discuss, I do not check messages here.',
      skills: ['WordPress'],
    }),
    ruleFlags: ['off_platform_contact'],
  },
  {
    key: 'flag-paypal-outside',
    job: job({
      title: 'Long-term web developer',
      description:
        'I will pay you through PayPal directly so we avoid the fees. Payment outside the platform, weekly.',
      skills: ['PHP', 'MySQL'],
    }),
    ruleFlags: ['off_platform_payment'],
  },
  {
    key: 'flag-registration-fee',
    job: job({
      title: 'Data entry team members wanted, $40/hour',
      description:
        'Work from home. A refundable registration fee of $25 is required to receive the training material.',
      skills: ['Data Entry'],
      hourly: true,
      budgetMinMinor: 4_000,
      budgetMaxMinor: 4_000,
      clientSpendMinor: 0,
      clientRating: null,
    }),
    ruleFlags: ['upfront_fee'],
  },
  {
    key: 'flag-free-sample',
    job: job({
      title: 'Logo for new brand — contest style',
      description:
        'Send a free sample logo first. I will pick the best one and hire that designer for the full brand.',
      skills: ['Logo Design'],
    }),
    ruleFlags: ['unpaid_test_work'],
  },
  {
    key: 'flag-unverified-payment',
    job: job({
      title: 'Build a Shopify store for my clothing brand',
      description:
        'Set up a Shopify store with 30 products, collections and a lookbook page. Photos provided.',
      skills: ['Shopify'],
      clientPaymentVerified: false,
      clientSpendMinor: 0,
      clientRating: null,
    }),
    ruleFlags: ['payment_unverified'],
  },
  {
    key: 'flag-crypto',
    job: job({
      title: 'Smart landing page for token launch',
      description:
        'Landing page with countdown and wallet connect. You will be paid in USDT on completion.',
      skills: ['Web3', 'React'],
    }),
    ruleFlags: ['crypto_payment'],
  },
  {
    key: 'flag-rent-account',
    job: job({
      title: 'Partner wanted with verified account',
      description:
        'I do the work, you rent your verified account to me and keep 20%. Share your login details and I handle the rest.',
      skills: ['Web Development'],
      clientPaymentVerified: false,
    }),
    ruleFlags: ['credentials_request', 'payment_unverified'],
  },
  {
    key: 'flag-exam',
    job: job({
      title: 'Take my online exam for web programming course',
      description: 'Take my online exam on JavaScript this Friday, 2 hours, must score above 80%.',
      skills: ['JavaScript'],
    }),
    ruleFlags: ['academic_dishonesty'],
  },
];
