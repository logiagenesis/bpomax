# Run log

One dated entry per scheduled build run: tickets completed with closing SHAs, new blockers.

## 22/09/2026 — session …iZW8GE

Completed:

- ARB-030 BullMQ queues, backoff retries, dead-letter queue, worker health endpoint — `dc4af58`
  (CI now runs a Redis service container)
- ARB-032 score worker with schema-checked output and rule-based red flags — `5e7865b`
- ARB-060 web design system, style guide and visual snapshots — `d8185f9`. The snapshots then
  failed in CI (run 19); the fix is `d08c247` and `9cad7b7`, green on the runner from run 24
  (D-026)

Also: untracked an empty `dump.rdb` that the local test Redis had written into the repo (`4197002`).

Not done:

- ARB-062 audit log page. Another scheduled session (…V4PPWs) was pushing to main at the same
  time and claimed ARB-062 on the board first, so this session stood down. It had already built
  the ticket (CSV export and actor list in the API, the page, 12 Playwright tests). That work
  is on branch `claude/exciting-fermi-5n7vtl` as an unmerged draft PR, to be compared with
  the claimant's version, not merged alongside it.

New blockers (docs/BLOCKERS.md):

- C-02: ARB-020 and ARB-022 need Freelancer.com developer credentials and sandbox accounts (B-03, B-04).
- D-15: ARB-040 to ARB-050 and ARB-061 each need an owner figure or decision (listed in the row).

Once ARB-062 is closed there are no unblocked tickets left. Every remaining ticket waits on
an item in docs/02-BLOCKERS.md.

Note for the owner: two scheduled sessions ran against main at once today and both built ARB-060
within ten minutes of each other. The IN PROGRESS claim on the board, which the other session
introduced, is now the lock. Running only one schedule at a time would avoid the duplicate
work altogether.

## 22/09/2026 — session …V4PPWs

Completed:

- ARB-001 repository, docs on main — `05b9769`
- ARB-002 monorepo scaffold — `7ff144c`
- ARB-003 CI, proved green and red — `4dddeb8`
- ARB-005 README and DECISIONS.md — `e0f8c85`
- ARB-011 row level security, proved against real Postgres — `ecfc49e`
- ARB-012 auth wiring, role split, approval integrity — `f34a587`
- ARB-014 audit log writer, reader and `GET /v1/events` — `8b18d29`
- ARB-021 scanner CRUD over the API with the auto-send guardrail — `02f516d`
- ARB-031 LLM package with schema validation, one retry and metering — `9e32179`
- ARB-062 audit log page with server-side CSV export — `39d4f39`, merged with main as
  `5189e9f`. The API side is session …iZW8GE's `63a9506`, taken with credit; the page and
  tests are this session's. The first page to call the API showed the API had no CORS
  (D-027).
- ARB-040 estimate worker: category from the model, price from the owner's rows, one test
  per branch, 11 mutants caught — `6c1f43a`. D-15 narrowed: the mechanism needed no figure,
  and B-10 moves to ARB-041 (D-028).
- ARB-041 margin engine: fee table with provenance, FX buffer, minimum rules, every line
  stored, hand-worked to the cent, 14 mutants caught — `208ea79`. Blocked in production
  until T-02, D-02, D-03 and B-10 are answered; it says so per job (D-029).
- ARB-042 bid allowance on the platform account, counted per month with an atomic
  reserve; unknown or spent allowance blocks with a clear message — `4b0d2e7` (D-030).
- ARB-043 draft-bid worker with a portfolio table: price from the margin output, timeline
  from the estimate, milestones summing to the cent, citations only to recorded items —
  `de42c51` (D-031). Blocked in production until D-07 (templates) and D-10 (portfolio) are
  answered; it says so per job.
- ARB-044 submit worker: approval, scanner cap, live gate on both switches with the
  would-send bid logged, allowance, pipeline item; platform call injected — `bfa74cb` (D-032).
  First clause proven; the sandbox clause stays on C-02.
- ARB-050 Telegram bot: link codes, commands, approval cards, Approve/Edit/Reject as the
  linked person, /pause held by the submit worker; Bot API names read from the official
  reference — `9d1fe12` (D-033). The sandbox clause stays on C-02; the token is B-09.

Built, then marked BLOCKED because the acceptance needs a figure or credential (docs/BLOCKERS.md):

- ARB-004 docker-compose and `.env.example` — `c194e1c` (V-01: no Docker daemon here)
- ARB-010 migrations for the full data model, verified with PGlite — `8c9c8fa` (C-01)
- ARB-013 category taxonomy seeded; price bands not seeded — `c21c34e` (D-14)
- ARB-015 retention job that redacts, and refuses to guess a period — `447e6a9` (T-06)

Blockers recorded: C-01, V-01, V-02, V-03, V-04, D-14.

Also: the board's IN PROGRESS claim was introduced here (`d801cbb`) after both sessions
built ARB-060 at once; this session's ARB-060 was discarded in favour of the one on main.

## 22/09/2026 — session …JmtXArNa (scheduled run, 22:46 UTC)

Completed:

- ARB-061 pages: login, dashboard, feed, approvals, settings, with their API routes,
  a Supabase token verifier, one validation function per form shared by page and API,
  `docs/audit/<page>.md` for every control, 79 Playwright tests and 25 route tests
  against real Postgres; 6 mutants caught — `3e72a7e` (D-035). The board claim from
  session …V4PPWs (19:51 UTC) was three hours old with no push and was taken over under
  D-034, recorded in `356fbce`.

Marked BLOCKED without work started, because the acceptance needs a credential:

- ARB-070 deploy — C-03 (no hosting account, B-11 and B-12).

New blockers (docs/BLOCKERS.md): C-03. D-15 narrowed: ARB-061 is built; its sign-in
waits on B-06 (V-03).

No unblocked tickets remain. ARB-099 needs all of Phase 1, and ARB-004, 010, 013, 015,
020, 022 and 070 each wait on an item in docs/02-BLOCKERS.md (B-03, B-04, B-06, B-11,
B-12, T-06, or a figure the owner must supply). Every Phase 2 to 4 ticket depends on
ARB-099. The highest-value answers remain T-02, D-02 and D-03 (the margin engine), then
B-06 (sign-in and the generated types) and B-11/B-12 (the preview link Phase 1 needs).


## 23/09/2026 — session …TC2vS5 (scheduled run)

Checked docs/04-PROJECT-BOARD.md, DECISIONS.md and docs/BLOCKERS.md, and re-verified the
build container (no Docker daemon; no SUPABASE_*, ANTHROPIC_*, FREELANCER_*, TELEGRAM_* or
hosting credentials in the environment; docs/02-BLOCKERS.md's Answer column is still empty
throughout).

Nothing has changed since the previous run (22/09/2026, session …JmtXArNa): ARB-004, 010,
013, 015, 020, 022 and 070 all still wait on an item in docs/02-BLOCKERS.md, ARB-099 still
needs all of Phase 1 (including ARB-070's live preview URL, C-03), and every Phase 2 to 4
ticket depends on ARB-099. No unblocked tickets remain. Stopping without any board changes.

The highest-value answers the owner can give remain T-02, D-02 and D-03 (the margin engine,
already built and waiting only on these), then B-06 (Supabase, for sign-in and generated
types) and B-11/B-12 (hosting, for the Phase 1 preview link).

## 23/09/2026 — session …G8QbdJJy (scheduled audit run)

Ran the full local verification suite rather than only re-reading the board, to check
whether anything marked DONE has actually regressed: `pnpm lint`, `pnpm typecheck`,
`pnpm test` (655 tests) and `pnpm test:e2e` (93 Playwright specs, including the visual
snapshots). All four are green. `git ls-remote origin main` matches local HEAD; the last
five GitHub Actions runs on main all succeeded.

Two things in this container are environment artefacts, not product bugs, and are noted
here so the next session does not mistake them for regressions:

- `pnpm test` fails 10 tests across `apps/workers` on a fresh container because no Redis
  is running (BullMQ has no fake worth using — the project already documents this class
  of gap for Docker, V-01). Starting `redis-server --daemonize yes` first (as CI's service
  container does) makes all 655 pass; nothing in the queue code changed.
- `pnpm test:e2e` fails every spec on a fresh container because this box ships a Chromium
  build the installed Playwright version (1.63.0) does not recognise by default. Setting
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to the pre-installed binary, exactly as the comment in
  `e2e/playwright.config.ts` describes, makes all 93 pass, snapshots included.

Confirms the prior run (…TC2vS5, same day): no unblocked tickets remain. ARB-004, 010,
013, 015, 020, 022 and 070 still wait on docs/02-BLOCKERS.md; ARB-099 still needs all of
Phase 1; every Phase 2 to 4 ticket depends on ARB-099. docs/02-BLOCKERS.md's Answer column
is still empty throughout — nothing here is a code defect, all of it is an owner action
(a credential, an account, or a figure the build already refuses to invent). No board or
code changes made.

Repo hygiene noted for the owner, not acted on here since neither PR is this session's:
`claude/exciting-fermi-5n7vtl` (#1) is a superseded ARB-062 draft whose own description
says "do not merge" — safe to close. `claude/eager-ritchie-bpufcs` (#2) is a clean,
mergeable, docs-only run-log entry from session …TC2vS5 that duplicates part of this one;
worth merging or closing before it drifts further behind main.

## 23/09/2026 — session …V4PPWs (resumed after its usage limit)

- The ARB-061 claim this session pushed at 19:51 UTC was taken over under D-034 while it
  was paused, and ARB-061 shipped green on main. This session's own unfinished pages
  (17 Playwright failures open) were not pushed, because that would have overwritten
  finished work. They are kept on a local branch, `arb-061-alternative` (`b28e9af`), which
  dies with this container. Nothing in them is missing from main.
- Fixed on ARB-061: "Cancel edit" on the settings page showed while nothing was being
  edited. `.btn` sets its own display, which outranks the browser's rule for the `hidden`
  attribute. One global `[hidden]` rule now wins for every component. The settings spec
  asserts the button is hidden on load, and that assertion fails without the fix.

No unblocked tickets remain; the list in the entry above still holds.

## 23/09/2026 — session …V4PPWs (ARB-004, then a handoff on the owner's instruction)

- ARB-004 DONE at `ececea4`. CI runs 53 and 54 failed in the compose job. The
  `supabase/postgres` image's own init script connects as `supabase_admin`, and
  `POSTGRES_USER=postgres` had replaced that role. With the image's default kept (and the
  database `postgres` on 54322, as the Supabase CLI has it), run 55's compose job was
  green. It also applied all 16 migrations to the real Supabase image.
- ARB-010 and ARB-013 were partly built and pushed unfinished: the generated types and
  their drift test, and the `db:migrate`, `db:seed` and `db:reset` scripts (D-038). Work
  stopped at the owner's instruction. docs/HANDOFF.md holds the exact next steps.
