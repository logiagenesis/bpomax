# Control and copy audit — index.html, the landing page (ARB-440)

Per docs/05 sections 1 and 2. The controls are tested in `e2e/landing.spec.ts`. The copy is
held to the section 2 rules by `tests/copy-audit.test.ts` (scarcity, countdowns, earnings
claims, guarantees, invented social proof, placeholders, US spelling, `lang="en-GB"`,
every page). Lighthouse is run in CI by `e2e/lighthouse.mjs` (`pnpm lighthouse`), which fails
below 90 in any category. On 24/09/2026, locally: index.html 100/100/100/100; signup.html
99/100/100/100; login, privacy and terms 100 in every category (performance,
accessibility, best practices, SEO).

## Controls

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the landing page | Goes to index.html | — | — | — | Never | Yes | says what the product does… (every link checked) | ✅ |
| Links ×3 (site navigation) | How it works / Safeguards / Marketplaces | Go to that section | index.html#how-it-works, #safeguards, #marketplaces; the section is in view | — | — | — | Never | Yes | the site navigation goes to each section on the page | ✅ |
| Link (navigation and hero) | Sign in | Go to sign-in | Goes to login.html | — | — | — | Never | Yes | Create an account goes to sign-up, and Sign in to the login page | ✅ |
| Link (hero, primary) | Create an account | Go to sign-up | Goes to signup.html | — | — | — | Never | Yes | as above | ✅ |
| Links ×4 (footer) | Privacy notice / Terms of service / Create an account / Sign in | Go to that page | privacy.html, terms.html, signup.html, login.html | — | — | — | Never | Yes | the footer links go to the privacy notice, the terms and the account pages | ✅ |

Page-level: a visit with `?ref=<code>` records a referral click and removes the code from
the address (ARB-430, tests in `e2e/affiliates.spec.ts`); no price, count, rating or
deadline appears (test "shows no price, count, rating or deadline"); no horizontal scroll
at 380 px; no request for an icon file (`<link rel="icon" href="data:,">`) until the owner
supplies one (docs/03 item 4).

## Copy: every claim, and what proves it

| Sentence on the page | Proved by |
|---|---|
| Finds freelance marketplace jobs that match your saved searches, scores each one, prices what delivering it would cost, checks the margin against your own rules, and drafts a bid for you to approve. | ARB-022 ingest (scanners), ARB-032 score, ARB-040 estimate, ARB-041 margin engine, ARB-043 draft into the approval queue |
| Your saved searches pull in new jobs from the marketplaces you connect. | ARB-021 scanners, ARB-022 and ARB-300 ingest for connected accounts |
| Each job is scored for fit, client quality, competition and red flags, with the reasons. | ARB-032: score, verdict, reasons, flags (`packages/core/src/scoring.ts`) |
| Delivery is estimated from your own rates, your suppliers or market bands, and the margin is worked out after platform fees, supplier cost and your FX buffer. | ARB-040 estimate order; ARB-041 margin lines (fee, supplier cost, FX buffer) |
| Only jobs that clear your margin rule get a draft bid, written from your own templates. | ARB-043: a passed evaluation and an active template are required (D-031) |
| When a client replies, a discovery conversation turns their answers into a structured brief. | ARB-130 discovery, ARB-131 brief |
| Decide who delivers: your own team, an AI-assisted build, or a supplier, ranked from your database or found through a sourcing post. | ARB-040 in-house and ai_build methods, ARB-201 ranking, ARB-202/203 sourcing posts |
| Won work is tracked through milestones, supplier handover, delivery and payment. | ARB-310 delivery orders, ARB-311 payments |
| Reply rate, win rate and realised margin per category, template, supplier and search. | ARB-320 analytics |
| Every bid, message and sourcing post waits for your approval, on the web or in Telegram. The only exceptions are ones you switch on yourself: auto-send for a saved search, which starts off and has a daily cap, and a first reply you write for when you are away. | ARB-044 approval rule, ARB-050 Telegram, ARB-062 approvals page; auto_send default false with daily_cap (ARB-021); auto-reply (ARB-121), off until switched on |
| Live mode starts switched off, and cannot be switched on until your margin rules, fee table and data-retention period are set. While it is off, nothing is sent: what would have been sent is logged instead. | `settings.live_mode` default false; `liveModeBlockers` (core) and the 0007 check; `external.blocked_by_live_mode` events (ARB-044) |
| No fee or price is guessed. Margins use the fee table you enter from each platform's own fee page, with its address and date. | ARB-041 and D-029: fee rules carry `source_url` and `read_on`; a missing rule blocks, never defaults |
| Marketplaces are reached through their official APIs only. Arbitron never drives a browser signed in to a marketplace. | `scripts/check-no-browser-automation.sh` in CI (ARB-300, D-066); every endpoint cited |
| Your organisation's data is kept apart from every other organisation's. | ARB-011 RLS suite; ARB-400 isolation tests (`packages/db/src/signup.test.ts`) |
| Every state change and outside call is written to an audit log you can read. | ARB-014 events, the audit-log page |
| Freelancer.com: Find jobs, bid, message clients and post sourcing projects, through its official API and the account you connect. | ARB-020/022/044/120/122/203, `packages/freelancer` |
| Upwork: Read jobs only, through its official API, once Upwork approves the API key. Bids on Upwork are made on Upwork itself. | ARB-300 (C-04, D-066) |
| Built by Logi-Ink. | docs/01 section A: the product runs for Logi-Ink first |

Not on the page, on purpose: prices (D-12), figures of any kind, testimonials or ratings,
deadlines, and a product name other than the working name "Arbitron" (D-01). The logo,
the icons and the share image are the owner's to supply (docs/03); none is generated.
