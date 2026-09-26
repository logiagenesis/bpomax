# HANDOFF — 26/09/2026 (SAST)

Written by session …tJv8 (Claude Code), working the board on the owner's instruction:
one pull request per ticket, from the one branch `claude/beautiful-tesla-b6goej`, merged
into `main` as soon as CI is green. `main` is the only branch that matters.

**TL;DR**

- **Phase 5 is built.** The owner's audit LI-AUDIT-BPOMAX-TASKS-20260925 found
  engineering work the handoff of 24/09/2026 had missed (D-073). All of it is now on
  `main`: ARB-500 to ARB-540. Pull requests #35 to #46 are merged; #46 (ARB-540)
  carried this handoff.
- **Board.** 69 tickets:
  - 49 DONE;
  - 16 BUILT-PENDING-CREDENTIALS;
  - 4 BLOCKED (the phase audits);
  - 0 TODO.
- **Nothing more can be built without the owner.** Section 5 lists what the owner
  supplies, with the ticket each unblocks.
- **Live.** https://bpomax.vercel.app runs production from `main`, in demo mode until
  the Supabase and API values are set on the Vercel project (D-043).
- **Next.** The owner's items in section 5, then each unblocked ticket's own clause
  (section 6).

## 1. State of `main`

| Item | Value |
| --- | --- |
| Repository | https://github.com/logiagenesis/bpomax (branch `main`; public, D-22) |
| Live web app | https://bpomax.vercel.app (Vercel project `bpomax`, team logi-ink; demo mode, D-043) |
| Last merges | PR #45 (ARB-531), PR #46 (ARB-540, 12049e7), then a follow-up recording that SHA |
| CI | Four jobs on Node 24, on every push and pull request (details below) |
| Other writer on `main` | None. Board changes travel in each ticket's own pull request (D-073). |

The four CI jobs:

- **Lint, typecheck and unit tests:** install, `pnpm audit`, lint, the browser guard,
  format, typecheck, the e2e typecheck, knip, and the unit tests on real Redis and
  Postgres.
- **End-to-end tests:** Playwright and Lighthouse on the e2e build, then the demo build.
- **docker compose up healthy:** the stack, `db:reset`, the seed twice, and Vault.
- **Secret scan:** gitleaks over every commit.

## 2. Board status (docs/04-PROJECT-BOARD.md)

| Status | Count | Tickets |
| --- | --- | --- |
| DONE | 49 | 001–005, 011, 012, 014, 021, 030–032, 040–043, 050, 060–062, 121, 122, 130, 131, 140, 200–202, 204, 210, 310–312, 320, 330, 340, 440, 500–502, 510, 512–514, 520, 522, 530, 531, 540 |
| BUILT-PENDING-CREDENTIALS | 16 | 010 (B-06), 013 (D-14), 015 (T-06), 020, 022, 120, 203 and 511 (C-02), 044 (C-02, T-01, B-05), 070 (B-12), 300 (C-04), 400 (D-16, B-06), 410 (D-12, B-13), 420 and 430 (C-05), 521 (D-17) |
| BLOCKED | 4 | 099, 299, 399, 499: each needs every ticket of its phase DONE, and the deployed API (B-12) for its links |
| TODO | 0 | — |

The audit's D-B asked for ARB-015, 044, 050 and 070 to be re-classified, because their
gaps were engineering work, not only credentials. That engineering is now done:

- ARB-510 (D-075): the API, workers and bot start and fail closed, and every queue is
  composed.
- ARB-511 and ARB-512 (D-077, D-078): the bid placer with the crash window closed, and
  one approval module for the page and the bot.
- ARB-500 (D-074): the link-code takeover closed.
- ARB-520 (D-076): retention that redacts and closes idle conversations.

What each row still waits on is now only what its BLOCKERS entry names.

## 3. Phase 5 (this session, all on `main`)

| Ticket | What landed | Decisions |
| --- | --- | --- |
| (fix) | The ten workers' transactions through `inTransaction`, with a guard test | D-065 |
| ARB-500 | Security: a link code is its person's alone, the bot's pending state closed to the app, profile links http(s) only, the MCP label needs a key, a shorter token cache, the webhook secret compared in constant time | D-074 |
| ARB-510 | Production entry points for the API, workers and bot (`pnpm --filter <app> start`), fail-closed config, the composed runtime, `/health` and `/ready`, graceful stop | D-075 |
| ARB-520 | Retention that redacts, idle conversations closed, client text kept out of the audit log as fingerprints, sync that never restores what was redacted | D-076 |
| ARB-511 | The Freelancer.com bid placer (the documented create-bid call) and the crash window closed by finding an earlier bid (BUILT-PENDING-CREDENTIALS, C-02) | D-077 |
| ARB-512 | One conditional approval module for the web, MCP and Telegram: exactly one of two racing changes wins | D-078 |
| ARB-501 | Security headers, a content security policy on every page, rate limits | D-079 |
| ARB-502 | Column grants for the signed-in person and first-person "who" columns (0038) | D-079 |
| ARB-521 | "Download my data"; an owner's export or erasure of a client's conversations; person or org deletion designed (BUILT-PENDING-CREDENTIALS, D-17) | D-080 |
| ARB-522 | Terms of service enforced in `app.create_org` (0039); the privacy data inventory completed | D-081 |
| ARB-513 | Rand prices shown with VAT at the org's rate, beside the price without it | D-082 |
| ARB-514 | The weekly price refresh: bands from the house org's accepted deliveries | D-083 |
| ARB-530 | CI on Node 24, gitleaks, actions pinned by SHA, the e2e typecheck, Vitest 4.1.11 and `pnpm audit`, flaky tests fail, the guard reads the lockfile | D-084 |
| ARB-531 | No unused exports (knip in CI); the demo stand-in split into modules | D-085 |
| ARB-540 | The docs match the tree: this file, README, BLOCKERS C-01 and D-22, docs/02 B-01 and B-02 | D-086 |

The tickets before Phase 5 are on the board with their SHAs. Their decisions are D-001
to D-072.

## 4. How to work here

- **One branch.** Work only on `claude/beautiful-tesla-b6goej`; never create another.
  Per ticket:
  1. Fast-forward to `origin/main`.
  2. Build, with the board row and its decision in the ticket's own commit.
  3. Push, and open a draft pull request.
  4. When CI is green, mark it ready and merge it, passing the full head SHA.
  5. `git merge --ff-only origin/main`.

  Never `git reset --hard` or force-push (both denied).
- **Local services.**
  - `redis-server --daemonize yes`.
  - Postgres 16 at `postgresql://postgres:postgres@localhost:54322/postgres`, started
    with
    `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/tmp/pg-local/data -o '-p 54322 -k /tmp' -l /var/tmp/pg-local/log start"`.
  - Both die when the container pauses.
- **Checks.** Read every exit code: `pnpm -s … | tail` once hid a typecheck failure.
  - `pnpm install --frozen-lockfile`, `pnpm audit --audit-level high`, `pnpm lint`.
  - `sh scripts/check-no-browser-automation.sh`, `pnpm format:check`.
  - `pnpm typecheck`. Use `pnpm -r --no-bail typecheck` to see every package's errors at
    once.
  - `pnpm typecheck:e2e`, `pnpm knip`, `REDIS_URL=redis://localhost:6379 pnpm test`.
  - `pnpm build:web:e2e`, then
    `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm exec playwright test --config e2e/playwright.config.ts`
    and `pnpm lighthouse` with the same variable.
  - `build:web:demo` with `e2e/playwright.demo.config.ts`.
- **Node.** CI runs Node 24; the container has Node 22. To prove a change on 24, fetch
  `https://nodejs.org/dist/latest-v24.x/`'s linux-x64 tarball into the scratchpad, check
  it against `SHASUMS256.txt`, and put its `bin` first on PATH.
- **Official docs.** developers.freelancer.com, upwork.com, docs.stripe.com, paystack.com,
  vercel.app and advisory pages are read through the Firecrawl connector. Public GitHub
  repositories (an action's tags, a release's checksums) are read with `git ls-remote`
  and the release download.
- **Vercel.** The connector's `list_deployments` refuses the team id (403); call it
  without `teamId`.

## 5. What the owner supplies, and the ticket each unblocks

Full rows in docs/BLOCKERS.md and docs/02-BLOCKERS.md. Keys go in `.env` or the host's
secret store only, never in the repository or a message.

| Owner supplies | Unblocks |
| --- | --- |
| B-06 Supabase project (URL, anon key, service role key, DATABASE_URL), with D-05 the data region; set the Site URL and the redirect `https://bpomax.vercel.app/login.html` | ARB-010 (C-01), real sign-in (V-03), ARB-400, ARB-070 out of demo mode |
| B-12 a host for the API, workers and bot, then SUPABASE_URL, SUPABASE_ANON_KEY and API_URL on the Vercel project | ARB-070 (C-03); the links of every phase audit (ARB-099, 299, 399, 499) |
| B-07 a hosted Redis URL | the queues in production (ARB-030, ARB-070) |
| B-03 Freelancer.com developer app (redirect `https://bpomax.vercel.app/freelancer-callback.html`, scopes 1, 2, 5, 6 and `fln:project_create`) and B-04 one sandbox freelancer and one sandbox employer | ARB-020, 022, 120, 203, 511 (C-02); the sandbox clauses of ARB-044 and ARB-050; ARB-099, ARB-299 |
| B-05 the live Freelancer.com account, ID-verified | going live (ARB-044), after T-01 and D-18 |
| B-08 Anthropic API key | real model calls for ARB-031, 032 (V-04) |
| B-09 Telegram bot token | ARB-050; the Telegram alerts of ARB-120, 204, 410 |
| B-10 an FX rate provider | ARB-041 and ARB-311 for any deal not in rand |
| B-13 an email provider and a verified sending domain | ARB-410's email alerts, ARB-420's billing emails |
| B-14 Upwork API key, with T-04 Upwork's API terms read | ARB-300 (C-04), ARB-399 |
| B-15 Paystack and Stripe accounts, keys, a plan per product plan, the two webhook URLs | ARB-420, 430 (C-05), ARB-499 |
| T-01 Freelancer.com API terms, and D-18 a written position on the multi-tenant model | going live (ARB-044); other organisations connecting Freelancer.com (ARB-400) |
| T-02 Freelancer.com fee schedule; T-03 the membership plan and bid allowance | ARB-041, 204; ARB-042 |
| T-05 paying overseas suppliers (Exchange Control, invoicing, VAT) | the first live supplier payment (ARB-310, 311) |
| T-06 POPIA: retention period, privacy notice, operator agreements, the cross-border basis | ARB-015, live mode; with D-17, deleting a person or an org (ARB-521) |
| D-16 the terms of service in `apps/web/src/public/terms.json` | ARB-400 public sign-up, and org creation for anyone (ARB-522) |
| D-17 the audit log when a person or org is erased (the three designs in D-080) | ARB-521's delete half |
| D-19 whether the Supabase Data API stays reachable from browsers | ARB-502 (a setting in the Supabase project) |
| D-20 VAT on marketplace bids, for which clients, and in recorded payments (accountant) | ARB-513 beyond the display |
| D-21 branch protection and required checks on `main` (the audit's Q-07) | ARB-530's CI made binding |
| D-22 repository visibility: private (docs/01 rule 1) or public (as now) | the audit's D-G |
| D-01 product name and domain | ARB-400 branding, ARB-440's name |
| D-02 minimum margin (% and rand), D-03 FX buffer | ARB-041 |
| D-04 categories delivered in-house | ARB-040 |
| D-06 three starting saved searches | ARB-021's seed |
| D-07 bid templates, D-10 portfolio items | ARB-043 |
| D-08 auto-reply wording | ARB-121 in use |
| D-09 the supplier list (the Suppliers page template) | ARB-200, 201 with real suppliers |
| D-11 brand colours; the docs/03 assets (logo set, favicons, Telegram avatar, share image, empty states, README banner) | ARB-060's tokens, ARB-440's icons |
| D-12 SaaS plans: limits, prices with each provider's reference, grace days (`packages/db/seed/plans.json`) | ARB-410, 420; ARB-499 |
| D-13 who else gets operator access | ARB-012 (SOFT) |
| D-14 market price bands, or confirm they wait for the weekly refresh (D-083) | ARB-013; ARB-040's band method |
| Drive housekeeping G-01 to G-05 (the owner's, D-073) | — |

## 6. The exact next step

Nothing more can be built until the owner supplies an item from section 5. When one
arrives:

1. Put any key in `.env` (and the Vercel or host environment), never in a file in git.
2. Take the ticket it unblocks and run its own clause for real. The BLOCKERS row (C-01
   to C-05, V-03, V-04, D-14 to D-22) says what to run and what to record.
3. Move the row to DONE with the evidence, and clear the BLOCKERS row.
4. When every ticket of a phase is DONE and the API is deployed (B-12), run that phase's
   audit: the docs/05 checklist across the phase, the `phase-N` tag, and the report
   with the repository, latest commit, tag and live preview links.

**The audit's launch gate.** Before going live, check every line of the audit's section
11 on the deployed SHA.

- **True in code now:**
  - entry points that fail closed;
  - the model transport built, or flagged off;
  - bid placement with the crash window closed;
  - the Telegram takeover closed;
  - retention that redacts;
  - the data export;
  - column grants;
  - the content security policy and rate limits;
  - CI on supported Node with a secret scan and the e2e typecheck;
  - docs that match the tree.
- **Waiting on the owner:**
  - the sandbox bid (C-02);
  - the written terms positions (T-01, T-04, T-06);
  - delete and anonymise (D-17);
  - a hosted smoke test (B-06, B-07, B-12);
  - production leaving demo mode, which happens when the Vercel values exist (D-043).

## 7. Loose ends

- **Billing.** Changing plan is not built (D-070), nor a refund or reversal of a recorded
  payment (D-059), nor affiliate commission payout (D-071). The audit's E-09 asks the
  owner whether they are wanted.
- **MCP sign-in.** A sign-in token for the MCP server expires. A long-lived credential
  is the owner's call (the audit's E-10, D-062).
- **OAuth `state`.** It is not sent to Freelancer.com or Upwork: neither documents it
  (D-079). Check in the sandbox (C-02).
- **Price bands.** Marketplace samples and a band CSV import are not built (D-083).
- **Transactions.** Work inside `withUser` or `inTransaction` must use the `tx` it is
  given. The outer connection waits for the transaction, so a slip shows as a hanging
  test (D-063, D-065).
- **Freelancer.com stand-in.** Each ticket adds the endpoints it calls, in the
  documented shapes. `jobs.average_bid_minor` and the `jobs` client fields stay unfilled
  until the sandbox shows the documented shapes (D-045, C-02).
