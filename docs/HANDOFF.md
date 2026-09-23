# HANDOFF — 23/09/2026, 06:00 UTC (08:00 SAST)

Written by session …V4PPWs on the owner's instruction to stop starting new tickets.
`main` is the only branch in use. Everything this session wrote is pushed.

**TL;DR**

- **Board:** 21 of 55 tickets are DONE; 1 is IN PROGRESS (released); 5 are BLOCKED; 28
  are TODO.
- **CI:** green on main. The only red runs this session were 53 and 54. Both failed in
  the new compose job, and that is fixed at `ececea4`.
- **Next ticket:** finish **ARB-010**. Put `pnpm db:reset` and a second `pnpm db:seed`
  into the CI compose job (steps in section 4). Then build ARB-013's "seed" label.

## 1. State of `main`

| Item                    | Value                                                                    |
| ----------------------- | ------------------------------------------------------------------------ |
| Repository              | https://github.com/logiagenesis/bpomax                                   |
| Last code commit        | `19d78a6` (ARB-004 done; ARB-010/013 partly built)                       |
| CI on `ececea4`         | Run 55: all three jobs green (checks, end-to-end, compose)               |
| CI on `19d78a6`         | Run 56: all three jobs green                                                                 |
| Local unit tests        | 658 of 658 pass (44 files), with Redis on 6379                           |
| Other writer on `main`  | The hourly routine session …JmtXArNa. Fetch before starting any ticket.  |

## 2. Board status (docs/04-PROJECT-BOARD.md)

| Status      | Count | Tickets                                                         |
| ----------- | ----- | --------------------------------------------------------------- |
| DONE        | 21    | 001–005, 011, 012, 014, 021, 030–032, 040–044, 050, 060–062     |
| IN PROGRESS | 1     | 010, released at this handoff and free to take                  |
| BLOCKED     | 5     | 013 (D-14), 015 (T-06), 020 and 022 (C-02), 070 (C-03)          |
| TODO        | 28    | 099, then all of Phases 2–4 (120 to 499)                        |

BUILT-PENDING-CREDENTIALS (D-036) is in the legend, but no ticket has that status yet.
Once ARB-010, 013, 015, 020, 022 and 070 are built against stand-ins, they move to it.

This session closed **ARB-004** at `ececea4`:

- CI's compose job runs `docker compose up -d --wait` and applies every migration to the
  `supabase/postgres` image.
- `tests/env-example.test.ts` checks every docs/01 section J variable.
- V-01 in docs/BLOCKERS.md is cleared.

## 3. CI: failures and why

| Run                        | Job     | Result                  | Cause and fix                                                                                                                                                                                                                                                                                        |
| -------------------------- | ------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 53 (`d422d94`)             | compose | red                     | `arbitron-postgres exited (2)`. The job had no logs to show why.                                                                                                                                                                                                                                       |
| 54 (`6583adc`)             | compose | red                     | The added log step showed the cause. The image's init script (`migrate.sh`) connects as `supabase_admin`, but `POSTGRES_USER=postgres` had replaced that role. Fixed at `ececea4`: the image's default superuser is kept, and the database is `postgres` on 54322, as the Supabase CLI uses (D-037). |
| 55 (`ececea4`)             | all     | green                   | All 16 migrations applied to the Supabase image as `postgres`.                                                                                                                                                                                                                                       |
| 56 (`19d78a6`)             | all     | green | All three jobs passed on the code this handoff leaves behind; the migrations applied to the Supabase image again. |

The checks and end-to-end jobs were green on every run above.

## 4. What was in progress

### ARB-010 — migrations and generated types (IN PROGRESS, released)

Built and pushed in `19d78a6` (D-038):

- `packages/db/src/typegen.ts` reads the migrated schema and writes
  `packages/db/src/types.generated.ts` in the Supabase CLI's shape.
  `packages/db/src/typegen.test.ts` fails if the committed file drifts from the
  migrations. `pnpm db:types` regenerates the file.
- `pnpm db:migrate` (`scripts/db-migrate.sh`) is proven in CI.
- `pnpm db:reset` (`scripts/db-reset.sh`) recreates the compose Postgres with an empty
  `arbitron-postgres-data` volume, then migrates and seeds. It has **not yet run in CI**,
  and the build container cannot pull the Postgres image.
- `pnpm db:types:supabase` is the hosted-project drop-in. It needs B-06.

Exact next steps:

1. In `.github/workflows/ci.yml`, job `compose`, add the steps below after "Start the
   stack…". Copy the pnpm and Node set-up from the `check` job, because `db:seed` runs
   `tsx`.
   - `pnpm/action-setup@v4`
   - `actions/setup-node@v4`
   - `pnpm install --frozen-lockfile`
2. Replace the "Apply every migration…" step with `pnpm db:reset`, keeping
   `DATABASE_URL: postgresql://postgres:postgres@localhost:54322/postgres`.
3. Run `pnpm db:seed` a second time. Then assert with `psql` that
   `select count(*) from service_categories` = 22 and that `market_price_bands` is
   empty. That also proves ARB-013's "seed idempotent".
4. If it is green, set ARB-010 to BUILT-PENDING-CREDENTIALS, open only on B-06 (types
   from the hosted project). Narrow C-01 in docs/BLOCKERS.md to match.

If `db:reset` fails because `docker compose rm` cannot find the service, run the stack's
`docker compose up` first. The script assumes the compose project exists.

### ARB-013 — seed and the "seed" label (BLOCKED on D-14)

Built:

- `buildSeedSql()` (22 categories, and bands flagged `source='seed'`) is idempotent and
  tested.
- `pnpm db:seed` (`scripts/db-seed.sh`, `packages/db/scripts/print-seed.ts`) pipes the
  SQL into `psql`.
- `packages/db/seed/market-price-bands.json` is deliberately empty. No band figure is
  invented (D-14).

Still to build, all buildable now:

1. `GET /v1/price-bands` in `apps/api/src/routes/`, member-readable, joined to the
   category names. Add route tests next to `apps/api/src/routes/pages.test.ts`.
2. A "Market price bands" section on the settings page:
   - List each band with `badge--seed` for `source='seed'`.
   - With no bands, show an empty state that names D-14.
   - Add a case to `e2e/settings.spec.ts`, and a row to `docs/audit/settings.md`.
3. Set ARB-013 to BUILT-PENDING-CREDENTIALS, open on D-14 (the owner's figures).

## 5. Open blockers

Owner items in docs/02-BLOCKERS.md that hold up tickets today:

| Blocker              | What is needed                                   | Holds up                                           |
| -------------------- | ------------------------------------------------ | -------------------------------------------------- |
| B-03, B-04           | Freelancer.com developer app, and sandbox users  | ARB-020, 022 (C-02); the sandbox clauses of 044, 050 |
| B-05, T-01, T-03     | The live account, API terms, bid allowance       | Live mode                                          |
| B-06, D-05           | Supabase project and region                      | Hosted types (010), sign-in round trip (012, V-03) |
| B-08                 | Anthropic API key                                | A real model's scores (V-04)                       |
| B-09                 | Telegram bot token                               | ARB-050 live                                       |
| B-10                 | FX provider                                      | Live FX (ARB-040)                                  |
| B-11, B-12           | Front-end and back-end hosting                   | ARB-070, so ARB-099 and the `phase-1` tag (C-03)   |
| T-02, D-02, D-03     | Fee schedule, minimum margin, FX buffer          | Margin engine on real figures (041)                |
| T-06                 | POPIA retention period and privacy wording       | ARB-015                                            |
| D-14                 | Market price band figures                        | ARB-013, and ARB-040's p50                         |

Build blockers (docs/BLOCKERS.md):

- **Open:** C-01, C-02, C-03, D-14, D-15, V-02, V-03, V-04.
- **Cleared:** V-01, today.

## 6. The exact next ticket

**ARB-010.** Do steps 1–4 in section 4 and push. Then continue in board order under
D-036: build each ticket against stand-ins and mark it BUILT-PENDING-CREDENTIALS.

1. ARB-013 (section 4).
2. ARB-015: privacy page scaffold, with T-06 wording left open.
3. ARB-020: Freelancer OAuth against a local fake, with pgsodium encryption proven on the
   compose image (clears V-02).
4. ARB-022, then ARB-070.

ARB-099 cannot be tagged without a live preview URL (B-11, B-12).

## 7. Loose ends

- A local branch `arb-061-alternative` (`b28e9af`) was never pushed. It is a superseded
  copy of ARB-061, and nothing in it is missing from main. It dies with this container.
- No ticket is claimed by this session. ARB-010 is marked released on the board.
