# HANDOFF — 23/09/2026, 09:11 UTC (11:11 SAST)

Written by session …tJv8 (Claude Code) while working the board on the owner's instruction
of 23/09/2026: one pull request per ticket, merged into `main` as soon as CI is green;
claims pushed straight to `main`; the web app kept live on Vercel from `main` (D-042,
D-043). `main` is the only branch that matters. Everything below is pushed.

**TL;DR**

- **Board:** 21 of 55 tickets are DONE; 6 are BUILT-PENDING-CREDENTIALS (010, 013,
  015, 020, 022, 070); 28 are TODO (099 and all of Phases 2 to 4). Nothing is BLOCKED
  outright any more: every Phase 1 ticket is built against a stand-in and waits only on
  the owner's credentials or answers (docs/BLOCKERS.md).
- **CI:** green on `main` at `3af24ef` (PR #7 merged; run 90 on its head). The ARB-022
  PR is open from `claude/beautiful-tesla-b6goej` and merges when green.
- **Live:** https://bpomax.vercel.app, production from `main`, in demo mode until the
  Supabase and API values are set on the Vercel project (D-043).
- **Next ticket:** after ARB-022 merges, Phase 2 under D-036: **ARB-120** (inbox sync)
  against the stand-in, citing developers.freelancer.com/docs/messaging. See section 6.

## 1. State of `main`

| Item                   | Value                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Repository             | https://github.com/logiagenesis/bpomax (branch `main`)                                  |
| Live web app           | https://bpomax.vercel.app (Vercel project `bpomax`, team logi-ink; demo mode, D-043)    |
| Last merge             | `3af24ef` = PR #7, ARB-020 end to end                                                   |
| Open PR                | ARB-022 ingest worker, head `5150f8d` plus the board commit, from `claude/beautiful-tesla-b6goej` |
| Local checks at `5150f8d` | lint, format, typecheck green; 746 unit tests (54 files) green with Redis and Postgres up |
| Other writer on `main` | The hourly routine session. Fetch before starting any ticket; claim on the board first. |

## 2. Board status (docs/04-PROJECT-BOARD.md)

| Status                    | Count | Tickets                                                     |
| ------------------------- | ----- | ----------------------------------------------------------- |
| DONE                      | 21    | 001–005, 011, 012, 014, 021, 030–032, 040–044, 050, 060–062 |
| BUILT-PENDING-CREDENTIALS | 6     | 010 (B-06), 013 (D-14), 015 (T-06), 020 and 022 (C-02), 070 (B-12) |
| TODO                      | 28    | 099, then Phases 2–4 (120 to 499)                           |

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
| B-03 Freelancer.com developer app (client id, secret, redirect URI, scopes 1, 2, 5, 6)      | ARB-020 and ARB-022 sandbox clauses; ARB-044 and ARB-050 sandbox clauses |
| B-04 one sandbox freelancer and one sandbox employer account                                | the same                                                                 |
| B-06 Supabase project (SUPABASE_URL, anon key, service role key, DATABASE_URL); D-05 region | ARB-010 hosted half, ARB-012 and ARB-061 real sign-in, ARB-070 out of demo mode |
| B-07 hosted Redis URL                                                                       | ARB-030 and ARB-022 in production                                        |
| B-08 Anthropic API key                                                                      | ARB-031, ARB-032 with a real model (V-04)                                |
| B-09 Telegram bot token                                                                     | ARB-050                                                                  |
| B-10 FX rate provider                                                                       | ARB-041, ARB-311                                                         |
| B-12 a host for the API, workers and bot                                                    | ARB-070 (the API half), ARB-099                                          |
| T-01 API terms; T-02 fee table; T-03 allowance; T-06 privacy period and wording             | ARB-044 go-live; ARB-041; ARB-042; ARB-015                               |
| D-02, D-03 margin rules; D-04, D-14 categories and bands; D-06 searches; D-07, D-10 content | ARB-041; ARB-040; ARB-021 seed; ARB-043                                  |

## 6. The exact next ticket

**ARB-120 — inbox sync.** Claim it on the board first. Build under D-036 against the
stand-in: add the documented Messaging endpoints to `packages/freelancer` (cite
https://developers.freelancer.com/docs/messaging/messaging and
https://developers.freelancer.com/docs/messaging/threads, read through Firecrawl), extend
`packages/freelancer/src/fake.ts` with threads and messages, and write the `inbox-sync`
worker in `apps/workers` on the pattern of `ingest.ts` (one schedule per connected
account; upsert `threads` and `messages`; `message.received` events; the operator alert
is a Telegram card, ARB-050's `apps/telegram`). T-01 gates nothing in a read; note it in
the board row. Then ARB-121 (auto-reply, D-08) and ARB-122 (outbound approval and the
LIVE_MODE gate, on the submit worker's pattern).

## 7. Loose ends

- The stand-in of Freelancer.com covers OAuth, `users/0.1/self` and the project search.
  Each later ticket adds the endpoints it calls, in the documented shapes.
- `jobs.average_bid_minor` is never written by the ingest: the docs do not say which
  currency `bid_stats.bid_avg` is in (D-045). The client fields on `jobs` stay null
  until a sandbox answer shows the `user_details` projection's shape (C-02).
- The board's ARB-021 row says its UI half is ARB-061; ARB-061 is DONE.
- V-02 (token encryption at rest) is CLEARED in docs/BLOCKERS.md; V-03 and V-04 stay.
