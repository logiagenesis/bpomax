# DECISIONS

Project: ARBITRON (working name) — Logi-Ink (Pty) Ltd
Format: newest first. Every decision that /docs leaves open, or that overrides /docs, is recorded here with the reason.

---

## D-001 — Repository: use `logiagenesis/bpomax`, do not create `logiagenesis/arbitron`

Date: 22/09/2026
Decided by: Owner (explicit instruction, this session)
Overrides: /docs/01-MASTER-BUILD-PROMPT.md rule 1, and /docs/04-PROJECT-BOARD.md ticket ARB-001

Decision:

- `gh repo create logiagenesis/arbitron` is NOT run.
- The repository already attached to this session, `logiagenesis/bpomax`, is the single source of truth for the build.
- `/docs` is committed and pushed to that repository's default branch.

Reason:

- The owner instructed this directly and repeated it. The session is scoped to `logiagenesis/bpomax`; creating a second repository would split the source of truth and put work outside the scope this session can reach.

Consequences:

- Everywhere /docs says `logiagenesis/arbitron`, read `logiagenesis/bpomax`. The /docs files are kept verbatim as delivered, so they still carry the old name; this entry is the authority.
- ARB-001's acceptance criteria are read against `logiagenesis/bpomax`.
- All other delivery rules stand unchanged, including rule 4: no phase is reported done without repository URL, commit URL, tag URL and live preview URL.

## D-002 — Default branch is `main`, created by the first push

Date: 22/09/2026
Decided by: Claude Code (recorded for the owner)

Observation:

- At the start of this session `git ls-remote origin` returned nothing: `logiagenesis/bpomax` was an empty repository with no commits and therefore no default branch.

Decision:

- The first commit is pushed to `main`, which creates it and makes it the default branch.

Reason:

- The owner asked for the push to go to the default branch. With no branch on the remote, one had to be named; `main` matches /docs, which refers to `main` throughout (rules 1 and 2, and audit protocol section 6.3).

## D-003 — /docs written from Google Drive, not from the zip

Date: 22/09/2026
Decided by: Owner (explicit instruction, this session)

Decision:

- The nine /docs files are read individually from the Drive folder "ARBITRON — Build Package" (`1_Xl8J-emQUmI2gMrNteTbXZunJRpDmPm`, reference subfolder `1mMkiJJhO896Bix3kD5VxPCj5A_ozqUWG`) and written byte for byte. `ARBITRON-build-package.zip` is not used.
- Each file was checked with `wc -c` against the sizes the owner supplied. All nine match:

| File                                      | Expected | Actual |
| ----------------------------------------- | -------- | ------ |
| 00-README.md                              | 2738     | 2738   |
| 01-MASTER-BUILD-PROMPT.md                 | 18458    | 18458  |
| 02-BLOCKERS.md                            | 6209     | 6209   |
| 03-IMAGE-GENERATION.md                    | 3753     | 3753   |
| 04-PROJECT-BOARD.md                       | 10365    | 10365  |
| 05-AUDIT-PROTOCOL.md                      | 3371     | 3371   |
| reference/R1-competitor-audit.md          | 9577     | 9577   |
| reference/R2-funnel-and-software-intel.md | 8036     | 8036   |
| reference/R3-early-build-brief.md         | 9311     | 9311   |

Note for the owner:

- A second, later copy of the same package exists in Drive (folder `1tDIk2rn8ASNjoLkN6ZJhHmBNSfw6RKX8`, the one the shared link in Build.txt points to). File sizes are identical across both copies. The copy named above is the one used. Worth deleting one of the two so there is a single source of truth in Drive as well.

## D-004 — Continuous board execution, no per-ticket check-in

Date: 22/09/2026
Decided by: Owner (explicit instruction, this session)

Decision:

- Work 04-PROJECT-BOARD.md continuously: commit and push after each ticket, update the board as we go, and do not pause for approval on settings, commit messages or minor choices.
- Minor choices are decided here in DECISIONS.md rather than raised with the owner.
- Only genuine blockers stop the work: missing credentials, a paid service, or a decision the docs contradict. Those go in docs/BLOCKERS.md and the dependent ticket is marked BLOCKED, per 01 rule 6.

## D-005 — Node 22 runtime locally, Node 20 as the floor

Date: 22/09/2026
Decided by: Claude Code

Observation:

- 01 section C fixes the stack at "Node 20 LTS". The build container runs Node v22.22.2 and pnpm 10.33.0; no Node 20 is installed and installing one is not worth a blocker.

Decision:

- `engines.node` is set to `>=20` so Node 20 remains supported and the docs' floor is honoured.
- CI pins Node 20 so the documented target is the one actually tested on every push.
- Local development on Node 22 is acceptable; anything that breaks on 20 will surface in CI.

## D-006 — docker-compose carries Redis and Postgres; the full Supabase stack is run by the Supabase CLI

Date: 22/09/2026
Decided by: Claude Code (ARB-004)

Context:

- 01 section C lists `docker-compose.yml  redis + supabase local`. "Supabase local" is ambiguous: Supabase's supported local stack is started by the Supabase CLI (`supabase start`), which orchestrates roughly ten containers of its own (Postgres, Auth, PostgREST, Storage, Realtime, Studio, Kong, and others) and is versioned with the CLI.

Decision:

- `docker-compose.yml` runs Redis and a Postgres built from the `supabase/postgres` image, which carries the extensions the migrations need, pgsodium included.
- The full Supabase stack is documented as `supabase start` rather than hand-copied into compose.

Reason:

- Hand-maintaining a copy of the Supabase stack in compose means tracking upstream version changes by hand and drifting from what Supabase supports. Redis and Postgres are the two dependencies application code actually opens sockets to; the rest of the stack is only needed when working on Auth or Storage locally, and the CLI is the supported way to get it.

## D-007 — LLM model defaults in .env.example

Date: 22/09/2026
Decided by: Claude Code (ARB-004)

Decision:

- `LLM_MODEL_SCORE` and `LLM_MODEL_DRAFT` both default to `claude-opus-5`.

Reason:

- 01 section C requires model names to be read from config and never hard-coded, so these are configuration values with sensible defaults, not a fixed choice.
- Scoring is the high-volume path and an obvious candidate for a cheaper model, but which model to run there is a cost decision for the owner, not one to make on their behalf. Changing `LLM_MODEL_SCORE` needs no code change, and ARB-031 meters token cost per call so the trade can be made on real numbers.

## D-008 — CI never cancels a run on main

Date: 22/09/2026
Decided by: Claude Code (ARB-003)

Observation:

- The first CI workflow set `cancel-in-progress: true` for every branch. Working the board ticket by ticket means several pushes to main in quick succession, and each one cancelled the run before it. Run 1 was cancelled by run 2, which would have been cancelled by run 3. No commit on main would ever have been verified.

Decision:

- `cancel-in-progress` is now `${{ github.ref != 'refs/heads/main' }}`: runs on main always finish; runs on other branches are still superseded by newer pushes.

Reason:

- Rule 2 treats each ticket's commit as a delivery in its own right, and 05 section 6 requires tests green before a ticket is done. A cancelled run proves nothing. Feature branches have no such requirement, so cancelling there still saves minutes.

## D-009 — Migrations are verified with PGlite, not only reviewed

Date: 22/09/2026
Decided by: Claude Code (ARB-010)

Context:

- ARB-010's acceptance is "applies cleanly". The compose Postgres cannot start in the build container (V-01) and there is no Supabase project yet (B-06), so the obvious reading was "cannot be verified here".

Decision:

- `packages/db/src/migrations.test.ts` applies every migration, in order, to PGlite — real Postgres compiled to WebAssembly, running in the test process — and then asserts the schema: every expected table, a uuid primary key on each, `updated_at` everywhere except the append-only `events`, and the behaviour of the safety constraints.

Reason:

- A migration that has only been read is not known to apply. This runs the actual DDL on every push, so a broken migration fails CI rather than surfacing the first time someone runs it against Supabase.
- It is not a replacement for applying them to Supabase before go-live: PGlite has no pgsodium and no `auth` schema, which is recorded as V-02.

## D-010 — Safety rules are enforced by database constraints, not only by application code

Date: 22/09/2026
Decided by: Claude Code (ARB-010)

Decision:

- Four rules from 01 section H are check constraints or unique indexes rather than application checks alone:
  - an outbound message cannot be marked sent without `approved_by` and `approved_via`;
  - a proposal cannot be `submitted`, and a sourcing post cannot be `posted`, without the same;
  - a scanner cannot have `auto_send` on without a daily cap and a minimum score;
  - a thread can have at most one auto-reply, ever (unique index on `thread_id`).
- `settings.live_mode` cannot be set true while any margin rule is missing.

Reason:

- These are the rules that decide whether a real message reaches a real client, and whether money is committed on numbers nobody supplied. Application code is where bugs live; a constraint holds regardless of which worker, migration or console session is writing. Each one has a test that proves the database refuses the unsafe write.

## D-011 — Tenancy is enforced by RLS policies over SECURITY DEFINER helpers in a private schema

Date: 22/09/2026
Decided by: Claude Code (ARB-011)

Decision:

- Every table in `public` has row level security enabled. Reads and writes are allowed only through a membership of the row's org; `anon` is granted nothing at all, and `service_role` bypasses RLS by design for worker and seed work.
- The policy predicates call helpers — `app.is_member`, `app.can_write`, `app.is_owner`, `app.shares_org`, `app.current_user_id` — that live in schema `app`, not `public`, and are `security definer`.
- Write access is split by role in the policies themselves: operators write ordinary records, only owners write `settings`, `subscriptions`, `usage_counters`, `affiliates`, `attribution` and `memberships`, and viewers write nothing.
- `events` has a select and an insert policy and deliberately no update or delete policy, on top of the rewrite rules from 0007.

Reason:

- Schema `app` keeps the helpers off PostgREST, which exposes `public` functions as RPC endpoints. There is no reason for a browser to be able to ask "am I a member of org X".
- `security definer` is not a convenience here, it is required: the policy on `memberships` has to read `memberships`, and an invoker-rights helper would recurse into its own policy.
- Splitting write access by role in the database is half of the ARB-012 acceptance ("viewer cannot approve; operator can; owner can change settings"). Put in the API instead, it would hold only for requests that go through the API.

## D-012 — The Supabase auth schema is shimmed in tests, not invented in a migration

Date: 22/09/2026
Decided by: Claude Code (ARB-011)

Context:

- The policies call `auth.uid()`, which Supabase supplies. PGlite does not have it, so the migrations would not apply in tests.

Decision:

- `packages/db/src/testing.ts` creates the `auth` schema, an `auth.uid()` matching Supabase's definition, and the `anon`, `authenticated` and `service_role` roles, before applying the migrations. It is test scaffolding and is never applied to a real database; no migration creates anything in `auth`.
- Every RLS assertion runs as the real `authenticated` role with JWT claims set exactly as PostgREST sets them.

Reason:

- A migration that created its own `auth` schema would collide with Supabase's and could mask a policy that is wrong against the real one.
- Running the assertions as the superuser would prove nothing: superusers bypass RLS, so the tests would pass against no policies at all. Switching role is what makes the result meaningful.
- The suite was mutation-tested: making `app.is_member` ignore the org turns 31 tests red. A test that cannot fail is not evidence.

## D-013 — Roles are defined once in the database and mirrored in code under test

Date: 22/09/2026
Decided by: Claude Code (ARB-012)

Decision:

- `packages/core/src/auth.ts` states what each role may do; the RLS policies in 0008 and 0009 enforce it. `packages/db/src/role-parity.test.ts` signs in as one member per role against real Postgres and asserts that the database's answer equals the function's answer, for writing, approving and changing settings.
- The code copy is for the interface only — greying out a button instead of letting someone press it and collect an error. It is never the thing standing between a viewer and an approval.

Reason:

- Two copies of an authorisation rule drift, and the copy that drifts is always the one nobody tested. Making the disagreement a test failure is cheaper than choosing one copy and pretending the other does not exist.
- Mutation-checked: making `canApprove` return true for everyone turns the viewer case red.

## D-014 — An approval records the person who made it, enforced by restrictive policies

Date: 22/09/2026
Decided by: Claude Code (ARB-012)

Decision:

- On `proposals`, `messages` and `sourcing_posts`, `approved_by` may only ever be set to the acting user. This is a RESTRICTIVE policy, so it is ANDed with the permissive ones in 0008 rather than widening them.
- An org cannot lose its last owner: a trigger refuses the delete or the demotion.

Reason:

- 0008 decides who may write the approval columns; it does not stop an operator writing the owner's name into one. Section H's rule is that an outbound action carries an approval, and an approval that can name someone who never gave it is not one.
- A permissive policy would have ORed with the existing write policy and changed nothing. That failure mode is silent, so it is mutation-tested: switching these six policies to permissive turns exactly the two tests that cover them red.

## D-015 — The API does not implement tenancy; it runs every read as the signed-in user

Date: 22/09/2026
Decided by: Claude Code (ARB-014)

Decision:

- `withUser(db, authUserId, work)` opens a transaction, sets `request.jwt.claims` and the `authenticated` role with `set local`, and runs the work inside it. Every tenant read goes through it.
- `listEvents` takes no `org_id`. Neither does any reader added later.

Reason:

- An API that passes `org_id` by hand is one forgotten `where` clause away from serving another tenant's data, and that clause is invisible in review. With RLS doing the scoping, a forgotten filter returns less than asked for, never more.
- `set local` is what makes this safe on a pooled connection: the claims and the role end with the transaction rather than waiting for the next request to notice them. There is a test that the session is back to the migration user after a request.
- Mutation-checked: removing the role switch from `withUser` turns three tests red, including the API's cross-org one.

## D-016 — Event types are a closed vocabulary

Date: 22/09/2026
Decided by: Claude Code (ARB-014)

Decision:

- `EVENT_TYPES` in `packages/core/src/events.ts` lists every event the system may write. `recordEvent` refuses anything else, and so does a filter on the viewer API, which answers 400 rather than an empty list.
- A user event must name a user and a system event must not.

Reason:

- An audit log is only useful if it can be searched, and free-text types drift into near-duplicates that no filter catches. Refusing an unknown type at the point of writing costs one line in a list; discovering six spellings of `proposal.submitted` a year in costs a migration.
- Answering 400 to a mistyped filter matters more than it looks: an empty result reads as "this never happened", which is exactly the wrong answer from an audit log.

## D-017 — Retention redacts, it does not delete, and refuses to run without a period

Date: 22/09/2026
Decided by: Claude Code (ARB-015)

Decision:

- `settings.retention_days` has no default. With it unset the job does nothing and writes a `retention.purged` event with outcome `skipped` saying why. Live mode is refused while it is unset, alongside the margin rules.
- When it is set, the job clears message bodies, thread client handles and discovery answers for **closed** conversations with no activity since the cutoff, and stamps `redacted_at`. Rows are never deleted.
- The privacy notice page carries no wording written here. Legal text is T-06's to supply.

Reason:

- Deleting a thread cascades into messages, discovery sessions, briefs, sourcing and the pipeline, and leaves the audit log pointing at rows that no longer exist. Redaction removes the personal information — which is what POPIA is about — while the figures in ARB-320 still reconcile.
- "Closed and quiet" rather than "old": an open conversation is still necessary for the purpose it was collected for, whatever its age.
- A retention job with a guessed period is worse than none: it deletes real data on an invented schedule and makes the compliance claim look satisfied. Standing down loudly is the honest failure.

## D-018 — The auto-send guardrail is checked against the scanner as it will be, not against the request

Date: 22/09/2026
Decided by: Claude Code (ARB-021)

Decision:

- `PATCH /v1/scanners/:id` reads the current row, applies the requested changes in memory, and runs `checkAutoSendGuardrails` on the result. An edit is refused if the _resulting_ scanner would auto-send without a daily cap and a score floor.
- The same rule is a check constraint in the database (migration 0002).

Reason:

- Validating only the fields in the request lets the rule be walked around in two steps: turn auto-send on with a cap in one call, clear the cap in the next. Each request looks fine on its own; the scanner ends up bidding with no ceiling.
- Keeping the constraint as well is not belt-and-braces for its own sake. Mutation-checked: disabling the application guardrail turns two tests red, and a third still passes because the database refuses the write on its own. That is what the second lock is for.

## D-019 — A scanner in another org answers 404, not 403

Date: 22/09/2026
Decided by: Claude Code (ARB-021)

Decision:

- `GET /v1/scanners/:id` for a scanner the caller cannot see returns 404. A write into an org the caller does not belong to returns 403, because they have already named the org themselves.

Reason:

- RLS makes "no such row" and "someone else's row" indistinguishable to the query, and that is the right answer to give back: 403 on a read would confirm the id exists, which is itself information about another tenant.
- On a write the caller supplied the `orgId`, so refusing it plainly tells them nothing they did not already assert.

## D-020 — Model prices are transcribed from the published page, and costs are kept in nano-dollars

Date: 22/09/2026
Decided by: Claude Code (ARB-031)

Decision:

- `packages/llm/src/pricing.ts` holds prices for the models this application may use, transcribed from https://platform.claude.com/docs/en/about-claude/pricing, with the date they were read. A model with no entry is refused at configuration time and at costing time, never metered at zero.
- Prices are held as whole nano-US-dollars per token, and a call's cost is integer arithmetic on them. `pricing.test.ts` checks the published cache multipliers against every row, so a transcription slip fails the build.

Reason:

- Recalled prices are wrong in the way that matters: silently, and by a plausible amount. The page is the only source, and the date on the table is what tells a reviewer how stale it is.
- A scoring call costs a fraction of a cent. Metered in cents, nearly every call rounds to zero and every monthly total is wrong in the same direction. Every price on the page is an exact integer in nano-dollars per token, so nothing is ever rounded.
- Retries are charged. A cost figure that leaves out the attempt that was thrown away understates precisely the calls worth knowing about. Mutation-checked: dropping the wasted attempt's usage turns the two metering tests red.

## D-021 — `llm_calls` is added to the data model

Date: 22/09/2026
Decided by: Claude Code (ARB-031)

Decision:

- Migration 0011 adds `llm_calls`, a per-call metering table, to the thirty-four tables in docs/01 section D. It carries tokens, cost, attempts, outcome and the validator's complaints — never the prompt or the reply.

Reason:

- Section D gives `job_scores` its own token columns, but scoring is not the only thing that calls a model; drafting, discovery and brief building all will, and none of their tables has anywhere to record a cost. ARB-320 has to answer "what did last month cost", which needs one place.
- Prompts and replies are excluded because they carry client content and this table is kept for years; the retention job (ARB-015) redacts conversations, and it should not have to know about this table to do so.

## D-022 — Queues: BullMQ 5, dead letters filed inside the processor, tests on a real Redis

Date: 22/09/2026
Decided by: Claude Code (ARB-030)

Decision:

- BullMQ is pinned to the 5.x line. 6.x had just been released and moves the Redis client
  behind an abstraction whose API differs from the documentation most of this code will be
  checked against.
- Every queue defaults to five attempts with exponential backoff from 5 s. A job whose last
  attempt fails, or that throws `UnrecoverableError`, is copied to a `dead-letter` queue
  by the processor wrapper _before_ the error is rethrown, with a job id derived from the
  original so a redelivery cannot file it twice.
- The worker `/health` endpoint answers 200 while Redis answers and 503 when it does not,
  within 2 s. Dead letters are reported as a count, not as ill health.
- The queue tests run against a real Redis — a service container in CI, `redis-server` or
  compose locally. There is no mock.

Reason:

- Filing the dead letter from the worker's `failed` event would run after BullMQ has
  already recorded the failure, so a crash in between loses it silently. Inside the
  processor, the job is not failed until its dead letter exists.
- A health check that waits on a lost Redis never answers (ioredis keeps reconnecting), and
  a host reads silence as "still starting", not "restart me". Found by the test.
- Restarting a worker does not fix a dead letter; alerting on the count does.
- BullMQ's behaviour lives in Lua scripts inside Redis. A fake would prove the fake.
  Mutation-checked: stopping the unrecoverable branch from dead-lettering turns three
  tests red.

## D-023 — Red flags are found by rules as well as by the model, and rules only make a verdict worse

Date: 22/09/2026
Decided by: Claude Code (ARB-032)

Decision:

- `detectRedFlags` in `packages/core/src/scoring.ts` looks for flags that are visible in
  the text or the client's stats: off-platform payment or contact, an upfront fee, crypto
  payment, a request for someone's account or documents, graded academic work, unpaid
  sample work, and an unverified payment method. Its findings are merged with the model's.
- Five flags are hard (`HARD_FLAGS`): a job carrying any of them is a `skip` with its
  score capped at 20 and reply probability 0, whatever the model said. Any other flag turns
  a `go` into a `caution`. Nothing here can turn a `caution` into a `go`.
- A reply that fails the schema twice (the first attempt and `completeJson`'s one retry) is
  final: the job goes to the dead-letter queue with `UnrecoverableError`, not round the
  queue's backoff. A transport error is retried by the queue as usual.
- `job_scores.cost_usd_minor` is in cents, rounded **up**. The exact cost stays in
  `llm_calls.cost_nano_usd` (D-020); the cents figure is for display beside the score.
- The score prompt carries the job and the client's platform statistics, never a client's
  name or handle.

Reason:

- A model that misses a scam once costs a real bid, a wasted connect or an account strike;
  a rule that fires on a false alarm costs the operator a glance. The acceptance test plays
  a model that misses every flag, so it proves the flags come from this code.
- The queue's retries exist for failures that might go away. A model that has been shown
  its own validation errors and still answers wrongly is not one of those, and each extra
  try is paid for.
- Rounding cents to nearest would show most scoring calls as free, which is the error
  D-020 exists to prevent.

## D-024 — Display formats: `R1 234,56`, SAST as a fixed UTC+2, and a bundled font

Date: 22/09/2026
Decided by: Claude Code (ARB-060)

Decision:

- Money is shown as `R1 234,56`: a no-break space groups thousands and a comma marks the
  decimal. docs/05 section 2 offers this or `R1,234.56` and asks for one choice used
  everywhere. Other currencies use the same digits with their ISO code in front
  (`USD 1 500,00`). Percentages use the decimal comma too (`28,4%`).
- `apps/web/src/lib/format.js` is the only place figures are formatted. It works on
  integer minor units with string and bigint arithmetic, never floats, and refuses a
  fractional amount instead of rounding it.
- SAST is a fixed UTC+02:00 offset rather than the browser's `Africa/Johannesburg` zone data.
- Inter is bundled with the build (`@fontsource/inter`), not loaded from a CDN.
- The brand colours are tokens in `apps/web/src/styles/tokens.css`. #00C2FF is used as
  docs/01 gives it, and the style guide says it is provisional until D-11 is answered.
- The visual snapshots allow a 2% pixel difference.

Reason:

- `R1 234,56` is the South African convention, and its no-break space keeps an amount on
  one line in a narrow column at 380 px.
- South Africa has observed no daylight saving since 1944, so a fixed offset is correct.
  It also gives the same output on every machine whatever time zone data the browser has.
- A system font stack renders differently on every machine, so a pixel snapshot of it
  would fail in CI on the first run. With a bundled font, the only differences left are
  small rasterisation differences between Chromium builds. The 2% tolerance covers those,
  and a real component change moves far more pixels than that.

## D-025 — Visual baselines are rendered by CI, never committed from a working machine

Date: 22/09/2026
Decided by: Claude Code (ARB-060 follow-up, CI run 19)

Context:

- Run 19 failed both visual snapshots: the baselines had been rendered in a build container, and the CI runner produced a page 13 px shorter with 10% of pixels different. Bundling Inter (D-024) removes the font-family difference but not the rasteriser's.

Decision:

- The `visual-baseline` workflow (`workflow_dispatch`) renders the snapshots with `--update-snapshots` on the same runner image CI uses and uploads them as an artifact. Those files, and only those, are committed under `e2e/*-snapshots/`.
- A baseline is regenerated that way whenever the design system changes on purpose. The 2% tolerance in the spec stays, for runner-to-runner jitter.

Reason:

- The environment that compares is the only one that can render a baseline the comparison will accept. Any other baseline is a snapshot of the wrong machine, and it fails on the first run — as it did.

Outcome:

- Run 24 went green another way, recorded in D-026: the copy was reworded so no line sits within 2% of a wrap point, with a test that fails if one does, and every font face is loaded before the shot. What D-025 still rules out is committing a baseline CI has never passed; the workflow is the fallback when a Chromium update moves more than a wrap point.
