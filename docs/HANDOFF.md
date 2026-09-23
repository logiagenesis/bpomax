# HANDOFF — 23/09/2026, 17:30 UTC (19:30 SAST)

Written by session …tJv8 (Claude Code) while working the board on the owner's instruction
of 23/09/2026: one pull request per ticket, merged into `main` as soon as CI is green;
claims pushed straight to `main`; the web app kept live on Vercel from `main` (D-042,
D-043). `main` is the only branch that matters. Everything below is pushed.

**TL;DR**

- **Board:** 37 of 55 tickets are DONE; 8 are BUILT-PENDING-CREDENTIALS (010, 013,
  015, 020, 022, 070, 120, 203); 10 are TODO (099, 299, 300, 399, Phase 4). Nothing is BLOCKED
  outright any more: every Phase 1 ticket is built against a stand-in and waits only on
  the owner's credentials or answers (docs/BLOCKERS.md).
- **CI:** green on `main` at `fc4325a` (PR #26, the `withUser` concurrency fix, D-063,
  merged). The ARB-340 PR is open from `claude/beautiful-tesla-b6goej` and merges when green.
- **Live:** https://bpomax.vercel.app, production from `main`, in demo mode until the
  Supabase and API values are set on the Vercel project (D-043).
- **Next:** after ARB-340 merges, **ARB-300** (Upwork, built against a stand-in and
  BUILT-PENDING-CREDENTIALS on B-14 and T-04). ARB-299 waits like ARB-099. See section 6.

## 1. State of `main`

| Item                   | Value                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Repository             | https://github.com/logiagenesis/bpomax (branch `main`)                                  |
| Live web app           | https://bpomax.vercel.app (Vercel project `bpomax`, team logi-ink; demo mode, D-043)    |
| Last merge             | `fc4325a` = PR #26, `withUser` concurrency fix (D-063)                                 |
| Open PR                | ARB-340 templates page, from `claude/beautiful-tesla-b6goej`                           |
| Local checks at ARB-340 | lint, format, typecheck green; 985 unit tests (92 files) green; 220 + 30 Playwright tests green |
| Other writer on `main` | The hourly routine session. Fetch before starting any ticket; claim on the board first. |

## 2. Board status (docs/04-PROJECT-BOARD.md)

| Status                    | Count | Tickets                                                     |
| ------------------------- | ----- | ----------------------------------------------------------- |
| DONE                      | 37    | 001–005, 011, 012, 014, 021, 030–032, 040–044, 050, 060–062, 121, 122, 130, 131, 140, 200–202, 204, 210, 310–312, 320, 330, 340 |
| BUILT-PENDING-CREDENTIALS | 8     | 010 (B-06), 013 (D-14), 015 (T-06), 020, 022, 120 and 203 (C-02), 070 (B-12) |
| TODO                      | 10    | 099, 299, 300, 399, 400–440, 499                            |

ARB-099 (the Phase 1 audit and tag) needs every Phase 1 ticket DONE, so it waits on the
credentials; under D-036 the build continues into Phase 2 meanwhile.

## 3. This session's tickets (all on `main` except the open PR)

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
| (fix)   | `withUser` borrows a pool connection, uses PGlite's own transaction, or takes turns on one client, so concurrent requests each run as their own user; 3 tests that fail on the old one | D-063 |
| ARB-340 | Templates page: sends and replies counted by the `template_variant_stats` view (0030, the never-written counters dropped), verified against raw SQL; the drafter's even A/B split; a sent variant's words locked; the page, Templates in the nav, demo; 11 + 1 Playwright tests | D-064 |
| ARB-330 | MCP server (`apps/mcp`, SDK 1.30.1, stdio): the eleven tools over the API with the operator's token, approvals recorded as `mcp` (0029), `GET /v1/jobs/:id`, `POST /v1/jobs/:id/score`, `POST /v1/proposals/:id/submit`, `enqueueSubmit` re-runs a finished job, README setup for Claude Code and Claude Desktop; 24 tests | D-062 |

## 4. How to work here (what cost time this session)

- **Branch and PR:** `git fetch origin main && git checkout -B claude/<name> origin/main`,
  build, commit with the docs/05 checklist in the body, `git push -u origin <branch>`,
  open the PR (draft), mark it ready and merge with the GitHub tools once CI is green.
  Never `git reset --hard` or force-push (denied in `.claude/settings.json`). Deleting a
  remote branch from the session is refused (HTTP 403 by the git proxy); the owner
  deletes them. When the owner deleted every branch but `main` on 23/09, GitHub closed
  PR #7 unmerged; re-pushing the branch and reopening the PR recovered it.
- **Claims:** a one-line board change committed on a throwaway branch from `origin/main`
  and pushed with `git push origin HEAD:main`.
- **Local services:** `redis-server --daemonize yes`; Postgres 16 at
  `postgresql://postgres:postgres@localhost:54322/postgres`, started with
  `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pg-local/data -o '-p 54322 -k /tmp' -l /var/tmp/pg-local/log start"`.
  Both die when the container pauses; the worker tests then time out at 30 s.
- **Checks:** `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (with
  DATABASE_URL set), `pnpm build:web:e2e` then
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm exec playwright test --config e2e/playwright.config.ts`,
  and the same with `build:web:demo` and `e2e/playwright.demo.config.ts`. Always read
  the exit code: `pnpm -s … | tail` hid a typecheck failure once.
- **Official docs:** developers.freelancer.com and vercel.app are not reachable from the
  container; read them through the Firecrawl connector (`firecrawl_scrape`, markdown).
  The page metadata says 404 but the content is the real page.
- **Vercel:** the connector's `list_deployments` refuses the team id (403 "scope
  logi-ink"); call it without `teamId`.

## 5. Open blockers, by credential

Full rows in docs/BLOCKERS.md and docs/02-BLOCKERS.md. What the owner supplies, and the
ticket it unblocks:

| Owner supplies                                                                              | Unblocks                                                                 |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| B-03 Freelancer.com developer app (client id, secret, redirect URI, scopes 1, 2, 5, 6, and `fln:project_create`) | the sandbox clauses of ARB-020, ARB-022, ARB-044, ARB-050, ARB-120 and ARB-203; the real sends of ARB-121 and ARB-122 |
| B-04 one sandbox freelancer and one sandbox employer account                                | the same                                                                 |
| B-06 Supabase project (SUPABASE_URL, anon key, service role key, DATABASE_URL); D-05 region | ARB-010 hosted half, ARB-012 and ARB-061 real sign-in, ARB-070 out of demo mode |
| B-07 hosted Redis URL                                                                       | ARB-030 and ARB-022 in production                                        |
| B-08 Anthropic API key                                                                      | ARB-031, ARB-032 with a real model (V-04)                                |
| B-09 Telegram bot token | ARB-050, and the ARB-120 and ARB-204 alerts |
| B-10 FX rate provider                                                                       | ARB-041, ARB-311                                                         |
| B-12 a host for the API, workers and bot                                                    | ARB-070 (the API half), ARB-099                                          |
| T-01 API terms; T-02 fee table (the freelancer and the employer side); T-03 allowance; T-06 privacy period and wording | ARB-044 go-live; ARB-041 and ARB-204; ARB-042; ARB-015 |
| D-02, D-03 margin rules; D-04, D-14 categories and bands; D-06 searches; D-07, D-10 content | ARB-041 and ARB-204; ARB-040; ARB-021 seed; ARB-043                                  |
| D-08 auto-reply wording; D-09 the supplier list (through the template on the Suppliers page) | ARB-121 in use; ARB-200 and ARB-201 with real suppliers                  |

## 6. The exact next ticket

**ARB-300 — Upwork read-only job ingest via the official API.** Claim it on the board
first. Acceptance: "Jobs ingested with source=upwork; no browser automation anywhere in
codebase (grep check in CI)". It waits on B-14 (Upwork API key approval) and T-04 (Upwork
API terms and the agency/Business Manager rules), so build it against a stand-in and mark
it BUILT-PENDING-CREDENTIALS. docs/01 section B: Upwork's API is GraphQL with OAuth2;
RSS was discontinued on 20/08/2024; never automate a logged-in browser session. Read the
official Upwork API documentation through Firecrawl before writing a single call, and
cite every query, field and scope in code (the no-guessing rule); anything the docs do
not state is not written. Add the CI step that fails on any browser-automation
dependency or import (puppeteer, playwright outside `e2e/` and the dev dependency,
selenium, webdriver). `jobs.platform` must accept `upwork` (check the enum), with the same
per-org upsert and score hand-off as the Freelancer.com ingest (ARB-022). Then Phase 4 as
far as it can be built without D-01, B-13 and B-15; each Phase 4 ticket names what it
waits on.

## 7. Loose ends

- Work inside `withUser` must use the `tx` it is given: the outer connection now waits
  for the transaction (on PGlite, for ever), so a slip shows as a hanging test (D-063).
- A sign-in token for the MCP server expires; a long-lived credential (a personal access
  token or a device sign-in) is not built and needs the owner's say (D-062).
- A recorded payment cannot be corrected from the page (D-059): no refund or reversal
  kind exists in any ticket yet.
- The workers have no production entry point yet (B-12): each processor, the reprice one
  included (`createRepriceProcessor`, with `repriceAlert` from apps/telegram as its
  `alert`), is wired and tested, and the host's start script binds them.

- The stand-in of Freelancer.com covers OAuth, `users/0.1/self` and the project search.
  Each later ticket adds the endpoints it calls, in the documented shapes.
- `jobs.average_bid_minor` is never written by the ingest: the docs do not say which
  currency `bid_stats.bid_avg` is in (D-045). The client fields on `jobs` stay null
  until a sandbox answer shows the `user_details` projection's shape (C-02).
- The board's ARB-021 row says its UI half is ARB-061; ARB-061 is DONE.
- V-02 (token encryption at rest) is CLEARED in docs/BLOCKERS.md; V-03 and V-04 stay.
