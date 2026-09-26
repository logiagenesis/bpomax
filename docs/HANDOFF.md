# HANDOFF — 26/09/2026 (SAST)

Written by session …tJv8 (Claude Code), working the board on the owner's instruction of
23/09/2026: one pull request per ticket from the one branch `claude/beautiful-tesla-b6goej`,
merged into `main` as soon as CI is green. `main` is the only branch that matters.

**TL;DR**

- **Correction:** the handoff of 24/09/2026 said nothing buildable remained. That was
  wrong. The owner's audit LI-AUDIT-BPOMAX-TASKS-20260925 found engineering work that
  needs no credentials: no production entry point for the API, workers or bot; no
  composition of queues and processors; the Anthropic transport never built; the bid
  call an interface only; a Telegram link-code takeover; retention that can never redact.
  Those are Phase 5 on the board, ARB-500 to ARB-540 (D-073).
- **Board:** 69 tickets; see section 2.
- **Live:** https://bpomax.vercel.app, production from `main`, in demo mode until the
  Supabase and API values are set on the Vercel project (D-043).
- **Next:** Phase 5 in the order of section 6.

## 1. State of `main`

| Item                   | Value                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Repository             | https://github.com/logiagenesis/bpomax (branch `main`)                                  |
| Live web app           | https://bpomax.vercel.app (Vercel project `bpomax`, team logi-ink; demo mode, D-043)    |
| Last merge             | `79d3080` = PR #34, ARB-440 and the phase audits marked BLOCKED                          |
| Other writer on `main` | None found. Claims now travel in the ticket's own PR (D-073).                            |

## 2. Board status (docs/04-PROJECT-BOARD.md)

The owner's audit reopened four rows whose gaps are engineering, not credentials: ARB-015
(P-01, P-02), ARB-044 (E-04, E-05), ARB-050 (E-06, S-01) and ARB-070 (E-01, E-02). Each
names the Phase 5 ticket that closes it and returns to its earlier status when that merges.

| Status                    | Count | Tickets                                                     |
| ------------------------- | ----- | ----------------------------------------------------------- |
| DONE                      | 36    | 001–005, 011, 012, 014, 021, 030–032, 040–043, 060–062, 121, 122, 130, 131, 140, 200–202, 204, 210, 310–312, 320, 330, 340, 440 |
| BUILT-PENDING-CREDENTIALS | 11    | 010 (B-06), 013 (D-14), 020, 022, 120 and 203 (C-02), 300 (C-04), 400 (D-16, B-06), 410 (D-12, B-13), 420 (C-05), 430 (C-05) |
| TODO                      | 18    | 015, 044, 050, 070 (reopened); 500–502, 510–514, 520–522, 530, 531, 540 (Phase 5) |
| BLOCKED                   | 4     | 099, 299, 399, 499: each needs every ticket of its phase DONE, and the deployed API (B-12) for its links |

## 3. This session's tickets (all on `main`)

| Ticket  | What landed                                                                                                     | Decisions      |
| ------- | --------------------------------------------------------------------------------------------------------------- | -------------- |
| ARB-010 | CI compose job: `db:reset`, a second `db:seed` that changes nothing, migrations on the Supabase image           | D-037, D-038   |
| ARB-013 | `GET /v1/price-bands`, the Seed label on the settings page; no band is invented (D-14)                          | —              |
| ARB-015 | Daily retention run in the workers; privacy notice page that shows only approved wording                         | D-040          |
| ARB-020 | Freelancer.com OAuth end to end: `@arbitron/freelancer`, Vault tokens (0017), connect/callback/disconnect API, settings controls, callback page, demo | D-041, D-044 |
| ARB-022 | Ingest worker: one schedule per scanner, the documented project search, per-org upserts (0018), events, score jobs | D-045          |
| ARB-070 | Web app on Vercel from `main`; demo mode build; `claude/**` branches not deployed                              | D-042, D-043   |
| ARB-120 | Inbox sync: the documented thread and message lists per connected account, stored once, Telegram card per client message | D-046 |
| ARB-121 | Auto-reply once per thread while the operator is offline: rule, settings control, worker with the live gate | D-047 |
| ARB-122 | Outbound messages need approval: drafts on a thread, the approvals page beside the bids, a send-message worker with the live gate | D-048 |
| ARB-130 | Discovery sessions: the ten questions as versioned data, three at a time for approval, a client's reply read into answers, completeness | D-049 |
| ARB-131 | Brief builder: section F's schema in core, drafted from the answers by hand or by the model at 70 %, locked only when complete, versions kept | D-050 |
| ARB-140 | Conversations page: thread list and detail routes, messages with states, a reply for approval, the discovery and brief panels, demo, 18 + 2 Playwright tests | D-051 |
| ARB-200 | Supplier database: CSV template, parser and line-by-line validator in core, all-or-nothing import, export, the suppliers page, demo, 10 + 2 Playwright tests | D-052 |
| ARB-201 | Sourcing: deterministic ranking in core with a sentence per part, request from a locked brief (0023), the sourcing page with the shortlist, Start sourcing on conversations, demo, 13 + 2 Playwright tests | D-053 |
| ARB-202 | Sourcing post drafts: scope-only builder and client-identity check in core, title column (0024), draft/edit/approve/close/record-posted API, posts panel, demo, 9 + 1 Playwright tests | D-054 |
| ARB-203 | Sourcing projects on Freelancer.com: the documented employer calls and stand-in endpoints, a sender behind the live gate, bids collected as candidates (0025), budget rule on approval, Collect bids now, 3 Playwright tests (BUILT-PENDING-CREDENTIALS, C-02) | D-055 |
| ARB-204 | Reprice: a candidate's quote as a `candidate_quote` estimate judged by the ARB-041 engine, the employer fee on our own project's bids, `margin.repriced` events, the Telegram breach card, a reprice per new or changed bid, the Reprice button and Margin column, demo, 5 + 2 Playwright tests | D-056 |
| ARB-210 | Sourcing and suppliers pages re-walked (every control has a row and a test, checked by script; keyboard tests); sourcing posts on the approvals page with Approve, Edit link and Close; `GET /v1/sourcing-posts`; demo | D-057 |
| ARB-310 | Delivery orders: Choose on the sourcing page opens one at the quote; milestones reconciled in core and by 0026's check; the handover checklist from the brief; forward-only moves; the pipeline page (board by stage) with the order; demo; 16 + 2 Playwright tests | D-058 |
| ARB-311 | Payments: four kinds (0027), realised margin in core as docs/05 3.5 states it, the rate typed or from the FX provider (B-10) and never assumed, Paid when the client has paid the value, T-05's notice on a supplier abroad, the Payments panel on the pipeline page, demo; 6 + 1 Playwright tests | D-059 |
| ARB-312 | Retainers: the pipeline's retainer toggle checked with `validateRetainer`, logged; the dashboard total tested against a hand sum and raw SQL; the demo dashboard sums the tab's retainers; 2 + 1 Playwright tests | D-060 |
| ARB-320 | Analytics: the per-job view (0028, security_invoker), grouping in core, `GET /v1/analytics` verified against raw SQL, the analytics page, Analytics in the nav, demo; 7 Playwright tests | D-061 |
| ARB-300 | Upwork read only: `packages/upwork` (every call cited), the ingest for Upwork scanners, the connect flow, a 24-hour purge (0031, Upwork's terms), no bid drafted or sent for Upwork, `scripts/check-no-browser-automation.sh` in CI; 30 + 5 tests (BUILT-PENDING-CREDENTIALS, C-04) | D-066 |
| (fix)   | Every transaction through `inTransaction` (the ten workers and the Telegram link), with a guard test | D-065 |
| (fix)   | `withUser` borrows a pool connection, uses PGlite's own transaction, or takes turns on one client, so concurrent requests each run as their own user; 3 tests that fail on the old one | D-063 |
| ARB-340 | Templates page: sends and replies counted by the `template_variant_stats` view (0030, the never-written counters dropped), verified against raw SQL; the drafter's even A/B split; a sent variant's words locked; the page, Templates in the nav, demo; 11 + 1 Playwright tests | D-064 |
| ARB-400 | Public sign-up: Supabase's documented sign-up request, `app.create_org` (0032) making the org with the person as owner, onboarding with six steps read from the org's rows, the terms page (pending); a new org isolated from Logi-Ink on every tenant table both ways (123 tests) (BUILT-PENDING-CREDENTIALS, D-16) | D-067, D-068 |
| ARB-410 | Plans and limits: three metered actions per South African month, `plans` (0033, seed empty for D-12), the house org exempt, counters the system's alone, refusals in the worker and at the button (402), 80%/100% alerts to owners by Telegram and `@arbitron/email` (a stand-in until B-13) (BUILT-PENDING-CREDENTIALS) | D-069 |
| ARB-420 | Billing: `packages/billing` (Paystack and Stripe, every call cited, stand-ins), hosted checkout, signed webhooks re-read against the provider and applied once (0034), the grace period an owner setting, the daily sweep, the Billing page (BUILT-PENDING-CREDENTIALS, C-05) | D-070 |
| ARB-430 | Affiliates: codes for the house org's owner, a click with no personal data (0035), attribution at org creation, conversion at the first paid plan, the Affiliates page and its funnel (BUILT-PENDING-CREDENTIALS) | D-071 |
| ARB-440 | The landing page: factual copy only, every sentence traced to its proof; `tests/copy-audit.test.ts` on every page; Lighthouse in CI (`e2e/lighthouse.mjs`), 99–100 in every category (DONE) | D-072 |
| ARB-330 | MCP server (`apps/mcp`, SDK 1.30.1, stdio): the eleven tools over the API with the operator's token, approvals recorded as `mcp` (0029), `GET /v1/jobs/:id`, `POST /v1/jobs/:id/score`, `POST /v1/proposals/:id/submit`, `enqueueSubmit` re-runs a finished job, README setup for Claude Code and Claude Desktop; 24 tests | D-062 |

## 4. How to work here (what cost time this session)

- **One branch only (owner, 24/09/2026):** work on `claude/beautiful-tesla-b6goej`; never
  create another branch. Per ticket: fast-forward it to `origin/main`, set the board row to
  IN PROGRESS in the ticket's own first commit (no other writer exists, so claims no longer
  go straight to `main`, D-073), build and commit on the branch, push it, open the PR,
  merge when green, then `git merge --ff-only origin/main`.

- **PR:** commit with the docs/05 checklist in the body, `git push -u origin
  claude/beautiful-tesla-b6goej`, open the PR (draft), mark it ready and merge with the
  GitHub tools once CI is green, passing the full 40-character head SHA.
  Never `git reset --hard` or force-push (denied in `.claude/settings.json`). Deleting a
  remote branch from the session is refused (HTTP 403 by the git proxy); the owner
  deletes them. When the owner deleted every branch but `main` on 23/09, GitHub closed
  PR #7 unmerged; re-pushing the branch and reopening the PR recovered it.
- **Claims:** a one-line board change built on `origin/main` with git plumbing (no branch,
  section 4's first bullet) and pushed with `git push origin <sha>:main`.
- **Local services:** `redis-server --daemonize yes`; Postgres 16 at
  `postgresql://postgres:postgres@localhost:54322/postgres`, started with
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pg-local/data -o '-p 54322 -k /tmp' -l /var/tmp/pg-local/log start"`.
  Both die when the container pauses; the worker tests then time out at 30 s.
- **Checks:** `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (with
  DATABASE_URL set), `pnpm build:web:e2e` then
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm exec playwright test --config e2e/playwright.config.ts`,
  and the same with `build:web:demo` and `e2e/playwright.demo.config.ts`. Always read
  the exit code: `pnpm -s … | tail` hid a typecheck failure once.
- **Official docs:** developers.freelancer.com, upwork.com, docs.stripe.com, paystack.com
  and vercel.app are not reachable from the container; read them through the Firecrawl
  connector (`firecrawl_scrape`). Stripe serves each page as Markdown at `<page>.md`;
  Paystack's docs-v2.paystack.com renders the code samples its main site hides in tabs.
- **Lighthouse:** `pnpm build:web:e2e`, then
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm lighthouse`.
- **Vercel:** the connector's `list_deployments` refuses the team id (403 "scope
  logi-ink"); call it without `teamId`.

## 5. Open blockers: what the owner supplies, and the ticket each unblocks

Full rows in docs/BLOCKERS.md (C-, V-, D-14 to D-16) and docs/02-BLOCKERS.md. Keys go in
`.env` only, never in the repository or a message.

| Owner supplies | Unblocks |
| --- | --- |
| B-03 Freelancer.com developer app (client id, secret, redirect URI `https://bpomax.vercel.app/freelancer-callback.html`, scopes 1, 2, 5, 6 and `fln:project_create`) and B-04 one sandbox freelancer and one sandbox employer account | ARB-020, ARB-022, ARB-120, ARB-203 (C-02); the sandbox clauses of ARB-044 and ARB-050; ARB-099, ARB-299 |
| B-05 which live Freelancer.com account, ID-verified | going live (ARB-044) |
| B-06 Supabase project (URL, anon key, service role key, DATABASE_URL), with D-05 the data region | ARB-010 (C-01); real sign-in for ARB-012 and ARB-061 (V-03); ARB-400; ARB-070 out of demo mode |
| B-07 a hosted Redis URL | the queues in production (ARB-030, ARB-070) |
| B-08 Anthropic API key | real model calls for ARB-031 and ARB-032 (V-04) |
| B-09 Telegram bot token | ARB-050, and the Telegram alerts of ARB-120, ARB-204 and ARB-410 |
| B-10 an FX rate provider | ARB-041 and ARB-311 for any deal not in rand |
| B-12 a host for the API, workers and bot | ARB-070 (C-03); the links of every phase audit (ARB-099, 299, 399, 499) |
| B-13 an email provider and a verified sending domain | ARB-410's email alerts; ARB-420's billing emails |
| B-14 Upwork API key, with T-04 Upwork's API terms read | ARB-300 (C-04); ARB-399 |
| B-15 Paystack and Stripe accounts, keys, a plan per product plan in each dashboard, the two webhook URLs | ARB-420, ARB-430 (C-05); ARB-499 |
| T-01 Freelancer.com API terms | going live (ARB-044) |
| T-02 Freelancer.com fee schedule, freelancer and employer sides | ARB-041, ARB-204 |
| T-03 Freelancer.com membership plan and bid allowance | ARB-042 |
| T-05 legal structure for paying overseas suppliers | the first live supplier payment (ARB-310, ARB-311) |
| T-06 POPIA retention period and privacy notice wording | ARB-015; live mode |
| D-01 product name and domain | ARB-400 branding, ARB-440's name |
| D-02 minimum margin (% and rand) and D-03 FX buffer | ARB-041 |
| D-04 categories delivered in-house | ARB-040 |
| D-06 three starting saved searches | ARB-021's seed |
| D-07 bid templates and D-10 portfolio items | ARB-043 |
| D-08 auto-reply wording | ARB-121 in use |
| D-09 the supplier list (the template on the Suppliers page) | ARB-200, ARB-201 with real suppliers |
| D-11 brand colours and the logo, with the docs/03 assets (logo, icons, share image) | ARB-060's tokens; ARB-440's icons |
| D-12 SaaS plans: limits, prices with each provider's reference, the grace period (`packages/db/seed/plans.json`) | ARB-410, ARB-420; ARB-499 |
| D-13 who else gets operator access | ARB-012 (SOFT) |
| D-14 market price band figures | ARB-013, ARB-040's band method |
| D-16 terms of service wording (`apps/web/src/public/terms.json`) | ARB-400: public sign-up opens |

## 6. The exact next ticket

Phase 5, most severe first: ARB-500 (security fixes), ARB-510 (entry points and runtime),
ARB-520 (retention that redacts), ARB-511 and ARB-512 (bid placement, approvals),
ARB-501 and ARB-502 (headers, rate limits, grants), ARB-521 and ARB-522 (data subject
access, terms), ARB-513 and ARB-514 (VAT display, price refresh), ARB-530 and ARB-531
(CI), then ARB-540 (docs).

When the owner supplies an item from section 5:

1. Put any key in `.env` (and the Vercel or host environment), never in a file in git.
2. Pick the ticket it unblocks from the board and run its own clause for real: the
   BLOCKERS row for it (C-01 to C-05, V-03, V-04, D-14 to D-18) says exactly what to run
   and what to record.
3. Move the row to DONE with the evidence, and clear the BLOCKERS row.
4. When every ticket of a phase is DONE and the API is deployed (B-12), run that phase's
   audit: the docs/05 checklist across the phase, tag `phase-N`, and the report with the
   repository, latest commit, tag and live preview links.

## 7. Loose ends

- Changing plan is not built (D-070): an org with a running subscription is refused a
  second checkout; the owner ends the first with the provider.
- Affiliate commission is recorded, not paid (D-071); no attribution window is applied.

- Work inside `withUser` or `inTransaction` must use the `tx` it is given: the outer
  connection waits for the transaction (on PGlite, for ever), so a slip shows as a hanging
  test (D-063, D-065). `tests/transactions.test.ts` allows `begin` only in packages/db.
- A sign-in token for the MCP server expires; a long-lived credential (a personal access
  token or a device sign-in) is not built and needs the owner's say (D-062).
- A recorded payment cannot be corrected from the page (D-059): no refund or reversal
  kind exists in any ticket yet.
- The API, workers and bot have no production entry point yet: no start script binds them
  (the owner's audit, E-01 and E-02). ARB-510 builds them.

- The stand-in of Freelancer.com covers OAuth, `users/0.1/self` and the project search.
  Each later ticket adds the endpoints it calls, in the documented shapes.
- `jobs.average_bid_minor` is never written by the ingest: the docs do not say which
  currency `bid_stats.bid_avg` is in (D-045). The client fields on `jobs` stay null
  until a sandbox answer shows the `user_details` projection's shape (C-02).
- The board's ARB-021 row says its UI half is ARB-061; ARB-061 is DONE.
- V-02 (token encryption at rest) is CLEARED in docs/BLOCKERS.md; V-03 and V-04 stay.
