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

Built, then marked BLOCKED because the acceptance needs a figure or credential (docs/BLOCKERS.md):

- ARB-004 docker-compose and `.env.example` — `c194e1c` (V-01: no Docker daemon here)
- ARB-010 migrations for the full data model, verified with PGlite — `8c9c8fa` (C-01)
- ARB-013 category taxonomy seeded; price bands not seeded — `c21c34e` (D-14)
- ARB-015 retention job that redacts, and refuses to guess a period — `447e6a9` (T-06)

Blockers recorded: C-01, V-01, V-02, V-03, V-04, D-14.

Also: the board's IN PROGRESS claim was introduced here (`d801cbb`) after both sessions
built ARB-060 at once; this session's ARB-060 was discarded in favour of the one on main.
