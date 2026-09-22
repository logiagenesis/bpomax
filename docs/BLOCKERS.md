# BLOCKERS — raised during the build

Document: LI-BLKBUILD-ARB-0926 — opened 22/09/2026
Companion to docs/02-BLOCKERS.md, which is the owner's pre-build action list. This file
holds blockers found while building, per docs/01 rule 6.

Status values: OPEN / CLEARED.
Types: CREDENTIAL (owner must supply a key or account), DECISION (owner must choose),
VERIFICATION (built and self-checked, but a claim in the acceptance criteria cannot be
proven in the build container), CONTRADICTION (the docs disagree with themselves).

| # | Type | Ticket | What is blocked | What is needed, and from whom | Status |
|---|---|---|---|---|---|
| C-01 | CREDENTIAL | ARB-010, ARB-012 | The acceptance clause "generated types committed", and applying the migrations against a real Supabase project. `supabase gen types` needs a project to read the schema from. The migrations themselves are verified: every one is applied to a real Postgres (PGlite, in-process) on every push, and the schema, the append-only audit log and the safety constraints are asserted there. | Owner: clear B-06 in docs/02-BLOCKERS.md — create the Supabase project and supply SUPABASE_URL, the anon key, the service role key and DATABASE_URL. Also needs D-05 (data region), which depends on the POPIA advice in T-06. | OPEN |
| V-02 | VERIFICATION | ARB-010 | pgsodium token encryption. PGlite does not have the extension, so the `platform_accounts` token columns are typed and constrained but their encryption is not exercised in tests. (The `auth` schema is no longer part of this row: the RLS tests run against a shim matching Supabase's own definition — DECISIONS.md D-012 — so the policies themselves are proven here.) | Owner: once B-06 is cleared, run the migrations against the Supabase project and re-run the RLS suite against it in CI using the service role key. | OPEN |
| D-14 | DECISION | ARB-013, ARB-040 | Seed figures for `market_price_bands`. docs/01 says to seed bands flagged `source='seed'` but gives no numbers, and ARB-040 prices real bids off the p50 — so an invented band becomes an invented price on a real proposal. The seed mechanism is built, idempotent and tested; it ships zero bands. The estimate worker falls through to the next method while there are none. | Owner: supply a p25/p50/p75 per category and currency you stand behind — from your own completed projects, a rate you would quote, or a CSV of observed marketplace prices — or confirm that bands stay empty until the price-refresh worker has real data. Numbering continues docs/02-BLOCKERS.md, whose decisions end at D-13. | OPEN |
| V-03 | VERIFICATION | ARB-012 | The hosted sign-in round trip itself: `signInWithPassword`, the emailed confirmation, and the JWT Supabase mints. Everything the schema does with that identity is proven here — the trigger that provisions an application user, the role split, and the rule that an approval names the person who made it — but no real token has ever been issued. | Owner: once B-06 is cleared, create one test user in the Supabase project and sign in from the login page (ARB-061); the Playwright e2e run then covers it. | OPEN |
| V-04 | VERIFICATION | ARB-031, ARB-032 | The Anthropic transport (`packages/llm/src/anthropic.ts`). No request has ever reached the API, because there is no key (B-08). Everything around it is proven against a scripted transport: schema validation, the single retry with errors fed back, metering of both attempts, and the price table. The transport is kept to ~40 lines so that what is unverified is small and obvious. | Owner: clear B-08, set ANTHROPIC_API_KEY in .env, then run one scoring call (ARB-032) and confirm the usage figures it records against the Console. | OPEN |
| V-01 | VERIFICATION | ARB-004 | The acceptance clause "`docker compose up` healthy". The compose file is written and passes `docker compose config`, but this container has the Docker CLI without a running daemon (`/var/run/docker.sock` absent), so no image can be pulled or started. | Owner: run `docker compose up -d` on a machine with Docker running, confirm both services report healthy (`docker compose ps`), then set this row to CLEARED. Nothing in the repo needs changing first. | OPEN |

## Notes

- V-01 does not block later tickets. Application code is written against `DATABASE_URL`
  and `REDIS_URL`, so it does not care whether those point at compose, the Supabase CLI,
  or hosted instances.
