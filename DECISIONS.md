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

## D-026 — Why the style-guide snapshots now hold across Chromium builds (addendum to D-025)

Date: 22/09/2026
Decided by: Claude Code (ARB-060 follow-up, session …iZW8GE)

Context:

- Two sessions were fixing CI run 19 at the same time. This one found the cause of the
  380 px failure: one line of the warning paragraph was within half a percent of its wrap
  point, and CI's Chromium wrapped it. The page came out one line (24 px) shorter, and
  everything below that line moved.

Decision:

- The copy is reworded, and every font the page uses is bundled, including the monospace
  one. A Playwright test now fails if any text on the style guide is within 2% of a line
  break at 380 px or 1280 px.
- The baselines committed in 9cad7b7 were rendered in the build container. CI run 24 on
  that exact commit passed both snapshots, which shows they match what the runner draws.
- D-025's `visual-baseline` workflow stays the way to regenerate them. Rendering them
  on the runner and proving them on the runner are both valid; what D-025 rules out is
  committing a baseline that CI has never passed.

Reason:

- The wrap-margin test turns the failure mode into a named, local test failure with the
  offending sentence in the message, instead of a 10% pixel diff in CI.

## D-027 — The API answers the web app's origin only, with bearer tokens and no cookies

Date: 22/09/2026
Decided by: Claude Code (ARB-062, session …V4PPWs)

Decision:

- `buildServer` registers `@fastify/cors`. The allowed origin is `ServerOptions.webOrigin`,
  which is `APP_URL` from `.env`; when it is unset no cross-origin request is allowed at all.
- `credentials: false`. The session token travels in the `Authorization` header, read from
  `sessionStorage` by `apps/web/src/lib/api.js`, never in a cookie, so the browser is never
  told to send credentials and cross-site request forgery has nothing to ride on.
- Three response headers are exposed to the page: `content-disposition`, `x-export-rows` and
  `x-export-truncated`. They are what the CSV export tells the page about the file.

Reason:

- Two Playwright failures found the gap. Without CORS the page could not call the API from
  another origin at all; without the exposed headers the browser hid the file name and the
  row count, and the page reported an export of 0 rows.
- A wildcard origin would work today, because nothing ambient authenticates a request, but
  it gives up a control for no gain, and `APP_URL` already exists for exactly this.
- Four tests in `apps/api/src/server.test.ts` hold it. Each of three mutants (drop the
  exposed headers, allow any origin, turn credentials on) fails at least one of them.

## D-028 — The estimate worker prices from the owner's rows only, in the job's currency

Date: 22/09/2026
Decided by: Claude Code (ARB-040, session …V4PPWs)

Decision:

- The method order is the spec's: `in_house` → `rate_card` → `market_band` → `ai_build`.
  Each reads a row and nothing else. In-house means the category is ticked `in_house`
  (docs/02 D-04) and a supplier on the `in_house` channel has a rate card for it. A
  supplier rate card is any active supplier on the freelancer, upwork, fiverr or direct
  channels. A market band is the best one for the category and currency, observed sources
  before seed (`completed_projects` > `owner_csv` > `marketplace_sample` > `seed`), newest
  first, and a seed band is flagged `isSeed` in the event. The AI-build tier is the rate
  card of a supplier on the `ai_build` channel: reference R2 costs the AI-build pipeline
  "as a supplier tier", so it is a supplier row, not a new table.
- "Website categories only" is `AI_BUILD_CATEGORIES` in `packages/core`: website-build,
  wordpress, elementor, shopify, landing-page. The AI-build pipeline is a website template
  engine; an app, a game or a piece of writing is not a website. The owner can change the
  list; it is one constant.
- Several rate cards give low = the lowest, expected = the median, high = the highest, in
  integer minor units; an even count takes the mean of the two middle values rounded down.
- An hourly job is priced per hour from hourly rates. Bands are fixed-project prices and
  are never used for an hourly job.
- Only sources in the job's currency are read, and the estimate is stored in that currency.
  This worker does no conversion: the margin engine (ARB-041) is where the rate and its
  timestamp are stored with every other input line (05 section 3.4), so B-10 (the FX
  provider) blocks ARB-041, not ARB-040.
- No source means no estimate. The job gets an `estimate.created` event with outcome
  `skipped` and one line per method saying why it did not apply. No figure is synthesised,
  averaged in from another currency, or guessed.
- The category is asked of the model once, held to the taxonomy by the JSON schema (the
  enum is the seeded slugs, plus null), retried once on a bad reply, metered as purpose
  `estimate`, and stored on the job by migration 0012 (`jobs.category_slug`,
  `jobs.category_confidence`) so it is never paid for twice. A null answer is recorded as
  `no_category` and nothing is stored.
- The scorer hands over: after committing a score whose verdict is not `skip` it enqueues
  the estimate (`ScoreDeps.estimateQueue`, optional so the scorer still runs alone).

Reason:

- docs/01 rule 6 forbids invented figures, and D-15 listed ARB-040 as blocked on D-04, B-10
  and D-14 for that reason. The mechanism does not need the figures to exist; it needs
  them to be rows. Built this way it ships with every branch tested against figures the
  tests own and label as test data, and in production it writes `skipped` until the owner's
  rows exist. That is the same shape as ARB-021 (mechanism built, D-06 seed pending) and
  ARB-031 (transport scripted, V-04 pending).
- Eleven mutants (suppliers before in-house, in-house tick ignored, AI-build for every
  category, hourly jobs reading bands, seed band ranked first, upper-middle median, skipped
  verdicts estimated, inactive suppliers read, cards in any currency, category not stored,
  scorer enqueuing skipped jobs) each fail at least one test. Closing commit: `6c1f43a`.

## D-029 — The margin engine judges the client's ceiling in whole minor units, and a missing rule blocks rather than defaults

Date: 22/09/2026
Decided by: Claude Code (ARB-041, session …V4PPWs)

Decision:

- The formula is the spec's (01 section E, reference R3 section 3.4): margin = client
  budget − platform fee − supplier cost − FX buffer − tool costs. The budget judged is the
  job's upper bound (`budget_max_minor`, else `budget_min_minor`): a deal that cannot
  clear at the client's ceiling cannot clear at all, and one that does leaves the
  draft-bid worker room below it.
- The platform fee is the fee table's percentage of the budget, or the platform's minimum
  fee when that is more. The fee table is `settings.fee_table`, a JSON array of rules
  `{platform, project_type, side, percent, min_minor?, min_currency?, source_url, read_on}`;
  `parseFeeTable` refuses a rule without the official page it was read from and the day
  it was read (05 section 5.2, docs/02 T-02). Bids use the `freelancer` side; the
  `employer` side is for sourcing posts (Phase 2).
- The FX buffer is `fx_buffer_pct` of the budget when the deal is not in ZAR, and nothing
  when it is: a ZAR deal carries no exchange exposure.
- The supplier cost is the estimate's expected figure (D-028), in the job's currency; an
  estimate in another currency blocks rather than being converted in passing.
- Tool costs are a stored line, 0 until a paid boost or the like is entered at submission
  (ARB-044). No per-bid tool figure exists to assume.
- Two rules: `min_margin_pct` against margin ÷ budget, and `min_margin_zar_minor` against
  the margin converted to ZAR at the provider's rate, which is stored with its timestamp
  (`fx_rate_used`, `fx_rate_at`; 05 section 3.4). An hourly deal is judged per hour, so the
  ZAR minimum, a per-job amount, is not applied to it; the reason says so.
- Arithmetic is BigInt over whole minor units, rounded half away from zero; percentages
  with at most three decimals are scaled integers; rates are parsed exactly to eight
  decimals (`numeric(18, 8)`); `margin_pct` is kept to three decimals. No float touches money.
- The engine also returns `requiredPriceMinor`, the lowest price at which the deal clears
  both rules (null when the percentages leave nothing), in the event payload. That is
  what the draft-bid worker prices from (ARB-043: "price equals margin output").
- A missing rule blocks. `margin.evaluated` gets outcome `blocked` naming each rule not
  set (D-02, D-03, T-02), or the fee table's field errors, or the platform and project
  type no rule covers, or the FX provider that is not configured (B-10) — for a non-ZAR
  deal, and for a fee minimum quoted in another currency. A provider that exists but does
  not answer is an error the queue retries. Nothing is filled in.
- VAT is not a margin line. 01 section G's "shown to the operator VAT-inclusive at 15%
  where VAT applies" is a display rule for the interface (ARB-061); whether VAT applies to
  a given client is a tax question the owner answers with T-06's advice.
- `FxRateSource` is an interface in `apps/workers`; the provider adapter waits on B-10.

Reason:

- The acceptance is "hand-calculated test cases pass to the cent for fixed, hourly,
  multi-currency". `packages/core/src/margin.test.ts` works every expected value in a
  comment beside it, including the cent at which rounding decides the required price; the
  figures are the file's own test data, since T-02, D-02 and D-03 are open.
- Fourteen mutants (rounding half down, buffer on ZAR deals, fee minimum ignored, ZAR
  minimum per hour, tool costs dropped, an exact-boundary margin failed, fee rule matched on
  platform alone, a rule without its source accepted, a missing buffer read as 0, the
  minimum budget judged, idempotency per job, the rate not stored, currency mismatch
  ignored, the estimate worker not enqueuing) each fail at least one test.

## D-030 — The bid allowance lives on the marketplace account, is counted per SAST month, and an unknown allowance blocks

Date: 22/09/2026
Decided by: Claude Code (ARB-042, session …V4PPWs)

Decision:

- The plan name and monthly bid limit (docs/02 T-03) are columns on `platform_accounts`
  (migration 0013: `plan_name`, `monthly_bid_allowance`, `plan_recorded_on`), because the
  allowance is what the platform grants that account's membership, not a property of the
  org. Both are null until the owner records them.
- Bids used are counted in `usage_counters` under metric `bids:<platform>`, one row per
  calendar month in South African time (D-024's fixed UTC+2), with `period_start` the
  first of the month. The month is an assumption about the platform's cycle, recorded
  here so T-03's answer can correct it: if the allowance renews on the membership's own
  date, `bidPeriod` is the one function to change.
- A bid is taken with `reserveBid` before the platform is called: one conditional upsert
  that moves `used` only while it is below the allowance, so two submissions racing for
  the last bid cannot both take it. A submission that fails before the platform accepted it
  gives the bid back with `releaseBid`, never below zero. The submit worker (ARB-044) is
  the caller.
- An allowance that is null refuses with a message naming T-03; a platform with no
  account refuses; an allowance of zero refuses; the counter is not touched in any of
  these. A refusal carries the count, the limit, the plan name and the day the
  allowance resets, in plain language for the operator and the Telegram card.
- The allowance can be changed at any time: the count stands, the new limit applies from
  the next reservation.

Reason:

- The acceptance is "submission blocked with clear message when allowance reached", and
  docs/02 says T-03's figure will not be assumed. Refusing on an unrecorded allowance is
  the only reading of both together; a null read as "unlimited" would submit real bids
  against a limit nobody checked.
- `usage_counters` already exists for exactly this shape of count (01 section D), and its
  unique key (org, metric, period) is what makes the conditional upsert atomic.

## D-031 — The draft-bid worker writes the words; the price, the timeline, the milestones and the citations are decided by code

Date: 22/09/2026
Decided by: Claude Code (ARB-043, session …V4PPWs)

Decision:

- The bid amount is the margin evaluation's `client_budget_minor`: the price the stored
  margin was judged at (D-029), so "price equals margin output" is literal and the margin
  shown for a proposal is the margin at its price. The lowest clearing price stays in the
  margin event for the operator; editing down to it is the operator's call.
- The timeline is the estimate's `turnaround_days` when the estimate has one. When it has
  none (a market band carries no turnaround) the model proposes a number of days and the
  proposal is flagged `timelineSource: proposed_by_model` in its event, for the operator
  to check before approving. A proposal is never blocked for want of a turnaround alone.
- Milestones come from the model as titles and shares; `splitMilestones` normalises the
  shares and rounds down, with the remainder on the last, so they sum to the price to the
  cent whatever the model's arithmetic (05 section 3.5).
- Portfolio items are a new table (migration 0014), each `own_work` or `labelled_demo`
  with `permission_to_show` (docs/02 D-10, 01 section H). A draft is offered only
  active items with permission; the JSON schema's enum is exactly those ids, so a
  citation the owner did not record is rejected before it is read; the citation itself is
  a foreign key in `proposal_citations`, and a cited item cannot be deleted from under its
  proposal. Links are written into the body by code from the cited items; a body with a
  link in it is rejected and retried.
- The template is the job's category's, else a general one, only if active (D-07), and
  its variant the one with the best reply rate, then the most sent. No template means no
  draft: the event says `blocked` and names D-07. The worker writes no copy of its own.
- The proposal is stored `queued`, for approval (01 section H); the margin worker
  enqueues a draft only for a committed, passed evaluation. One draft per evaluation,
  unless it was rejected.
- The prompt carries the job, the client's platform record without names, the template,
  the price and timeline to quote exactly, and the offered items. It never carries the
  supplier cost or the margin. The system prompt forbids invented clients, results,
  reviews, deadlines, urgency and scarcity (01 section H).

Reason:

- The acceptance names three invariants; each is held by code and by the database, not by
  the prompt, and each has a mutant that breaks it and a test that catches the mutant.
  Eleven mutants (remainder dropped, links allowed, any citation accepted, demos
  unlabelled, unpermitted items offered, price from the budget, timeline always the
  model's, stored as draft, failed margin drafted, inactive template used, draft enqueued
  on a failed evaluation) each fail at least one test.
- The client's history, in the sense of previous threads with the same client, has no
  identity to hang on yet (jobs carry the platform's client statistics, not a client id);
  the prompt uses those statistics. A client id arrives with ingest (ARB-022, C-02).

## D-032 — Nothing leaves without approval, an open live gate on both switches, and an allowance; the platform call is an adapter

Date: 22/09/2026
Decided by: Claude Code (ARB-044, session …V4PPWs)

Decision:

- Order of checks at submission: the approval record (status `approved` with a named
  approver and channel; `submitted` is finished, anything else is skipped), then for an
  automatic approval its scanner's guardrails, then the live gate, then the account's bid
  allowance, then the platform. A check that fails records a `proposal.submitted` event
  with outcome `blocked` or `skipped` and a message the operator can act on.
- The live gate has two switches and both must be on: `LIVE_MODE` in the environment and
  `settings.live_mode` for the org, which the database refuses until the margin rules and
  the retention period exist. Closed, the worker writes an `external.blocked_by_live_mode`
  event whose payload is the bid that would have been sent — the fields, never an
  endpoint — and leaves the proposal approved. That is the ticket's first clause.
- An automatic approval (`approved_via = 'auto'`) is held at the moment of sending to the
  scanner that found the job: auto-send on, the job's score at or above the scanner's
  minimum, and one of the scanner's daily slots, counted per South African day in
  `usage_counters` with the same conditional upsert as the bid allowance. Jobs carry
  `scanner_id` from migration 0015 for this; the ingest worker (ARB-022) sets it. A
  person's approval is not capped: the person is the cap (01 section H).
- The bid is taken from the allowance (D-030) before the platform is called and given
  back if the platform refuses or no client exists. A refusal on a non-final attempt is
  rethrown for the queue's backoff; on the final attempt the proposal is marked `failed`
  with the platform's reason.
- The platform call is a `BidPlacer` the worker is given. None exists until the
  Freelancer client (ARB-020, C-02); live without one records `blocked` naming C-02 and
  sends nothing. The endpoint and its parameters belong to that client, with the official
  doc URL cited there (01 section B).
- A placed bid is recorded as an `external.call` event before its bookkeeping, and a
  later attempt that finds such an event finishes the bookkeeping instead of placing the
  bid twice.
- A placed bid opens the pipeline: a `pipeline_items` row at `applied` with the bid's value,
  and a `pipeline.stage_changed` event.

Reason:

- 01 section H in full: approval by default, a hard daily cap on auto-send, LIVE_MODE
  blocking every outbound call and logging what would have been sent. Each is a separate
  check with its own test and its own mutant. Fourteen mutants (gate on the environment
  alone, approval without an approver, milestones not summing, the cap day in UTC, the
  slot upsert ignoring the cap, the org switch ignored, the payload not logged, unapproved
  proposals sent, the allowance not consulted, the bid kept after a refusal, auto
  approvals not held to the scanner, a bid placed twice, a cap slot kept on a stopped
  send, no pipeline item) each fail at least one test.
- The second clause of the acceptance, a sandbox submission, needs the Freelancer client,
  developer app and sandbox accounts (C-02). It is the one part of this ticket that is not
  mechanism, and it stays open there.

## D-033 — The Telegram bot acts as a linked person, never as itself, and hands approved bids to the submit worker

Date: 22/09/2026
Decided by: Claude Code (ARB-050, session …V4PPWs)

Decision:

- A chat is linked to a person with a one-time code the web app issues under that
  person's own session (`POST /v1/telegram/link-codes`, RLS decides who may), sent to the
  bot as `/start <code>`. The code lives ten minutes and is used once; what it produces
  is `users.telegram_chat_id`. A new code moves the chat to whoever made it.
- Every write the bot makes names the linked user as actor, and every button is judged
  by that user's role: a viewer sees cards and stats but cannot approve, edit, reject,
  pause or resume (01 section H, `canApprove`). A bid from another org does not exist to
  this chat.
- Approve sets the proposal `approved` with `approved_via = 'telegram'`, records the
  event, closes the card's buttons and enqueues the submit worker (D-032), which holds
  the live gate, the allowance and the platform call. Telegram never touches a
  marketplace.
- Edit and Reject ask for the next message. An edit puts the proposal back to `queued`
  with its approval cleared: the old approval covered the old words. A reject records
  the reason on the proposal and in the event. A sent bid can be changed by neither.
- `/pause` sets `settings.bidding_paused`; the submit worker then sends nothing, whoever
  approved it, and keeps the approval. `/resume` clears it and re-enqueues every approved
  bid. Both are events with the person named.
- The card reads stored rows only: the job title, the latest score, the price and
  timeline, the estimate's expected cost and method, and the margin from the evaluation,
  in the deal currency and in ZAR at the rate the evaluation stored (05 section 3.4). The
  money format is D-024's, ported to `packages/core` and held to the same outputs.
- The Bot API adapter uses the method and field names read from the official reference
  on 22/09/2026 (its latest changes dated 24/08/2026): sendMessage, InlineKeyboardMarkup
  with callback_data of at most 64 bytes, answerCallbackQuery with at most 200
  characters, editMessageReplyMarkup, setWebhook with `secret_token`, which Telegram
  returns in the `X-Telegram-Bot-Api-Secret-Token` header. The webhook refuses an update
  without that header and answers 200 to every accepted one, so Telegram never resends.
  The token is in the request URL and nowhere else.
- Telegram messages to the operator are not marketplace calls and are not gated by
  LIVE_MODE: the gate is about clients and platforms (01 section H), and a bot that
  could not speak to its operator in development could not be tested.

Reason:

- The acceptance's three clauses: Approve hands off to the submit worker, which is the
  sandbox call's place and stays on C-02; Edit replaces the text; Reject records the
  reason. Each has a test against real Postgres and a scripted Telegram. Ten mutants
  (viewers approving, the org ignored, an edit keeping its approval, the reason dropped, a
  used code linking again, the approval not enqueued, resume re-queuing nothing, cards
  pushed to viewers, the ZAR margin at the wrong rate, the secret header unchecked) each
  fail at least one test.
- core.telegram.org is blocked by this environment's egress proxy; the reference was read
  through a browser service instead, so 01 section B's rule (names confirmed against the
  official docs, cited in code) is met rather than worked around.

## D-034 — A board claim with no push for an hour is stale and may be taken over

Date: 22/09/2026
Decided by: Claude Code (session …JmtXArNa)

Context:

- The IN PROGRESS claim on the board is the lock between scheduled sessions (run log,
  22/09/2026). ARB-061 was claimed by session …V4PPWs at 19:51 UTC. That session had
  closed every earlier ticket within fifteen minutes of claiming it; at 22:46 UTC, nearly
  three hours later, nothing had been pushed to any branch, and the board had been still
  since the claim. A lock that can never be broken stops the board for good when a session
  is reclaimed mid-ticket.

Decision:

- A claim is stale when the claimant has pushed nothing for sixty minutes. A later session
  may take it over by replacing the claim with its own, naming the claim it replaced and
  the time, in the same commit, before starting work.
- Anything the earlier session pushed is kept and built on; nothing is discarded.

Reason:

- Sixty minutes is four times the longest claim-to-close interval seen on this board, and
  short enough that a dead session costs at most one run. A live session that has gone
  quiet for an hour on one ticket has itself stopped pushing after each ticket, which D-004
  asks for.

## D-035 — The pages read stored rows and call the API; sign-in is Supabase's password grant verified server-side; one copy of every form rule

Date: 22/09/2026
Decided by: Claude Code (ARB-061, session …JmtXArNa)

Decision:

- Sign-in is `POST {SUPABASE_URL}/auth/v1/token?grant_type=password` from the browser,
  the request `supabase.auth.signInWithPassword()` makes, with the project's public anon
  key; no client library is added for one call. The session is kept in `sessionStorage`
  for the tab (D-027: bearer tokens, no cookies). The API verifies a token by asking the
  same server who it belongs to (`GET /auth/v1/user`, `apps/api/src/auth.ts`), which
  holds whichever key the project signs with, so no signing secret is kept in the API. A
  verified token is remembered for one minute. Both endpoints are cited in code.
- The browser build reads `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `API_URL` — three of
  docs/01 section J's own names — from the repository's `.env` or the host's
  environment (`apps/web/vite.config.js`), rather than a second `VITE_`-prefixed set
  that could drift from the first. Nothing else in `.env` reaches the browser. The
  end-to-end build (`vite build --mode e2e`) reads `/.env.e2e`, committed stand-in
  hosts the specs intercept; without it the login form is disabled with the reason
  and no spec could exercise it.
- Every form is checked before it sends with the same `@arbitron/core` function the API
  runs on the same body — `validateMarginRules`, `parseFeeTable`, `validatePlanRecord`,
  `validateScanner`, `checkAutoSendGuardrails`, `validateProposalEdit`,
  `validateRejection` — so docs/05 section 1.5 ("the same rules") is met by having one
  copy, not two kept in step. The API's 422 field errors land on the same fields.
- The dashboard's figures are the API's (`GET /v1/dashboard`), each a sum or count over
  stored rows with its formula written beside it; the page formats and never calculates
  (05 section 3.3). Money crosses the wire as text and is formatted with BigInt. The
  month is the South African calendar month (D-024, D-030). Win rate is won ÷ (won +
  lost) over pipeline items decided this month; a payment in another currency with no
  stored rand figure is listed as unconverted rather than guessed into a total.
- "Queue bid" on the feed asks for a bid, it does not make one: the API drafts from a
  passed margin evaluation (D-031), scores a job nobody has looked at (the chain then
  carries it), and otherwise refuses with the stored reason. It records
  `proposal.draft_requested` naming the person; the vocabulary gains that one type.
- Approvals on the web are the Telegram bot's rules (D-033) reached from a page:
  `approved_via = 'web'`, the approver is the caller by the restrictive policy in 0009,
  an edit clears the approval, a rejection records its reason, a sent bid changes for
  nobody. Bulk approve and reject run one bid per transaction and report each outcome,
  so a bid that moved on since the page loaded does not stop the rest.
- Live mode's org switch (D-032) is refused, with the list, while any rule is missing —
  the same list the database constraint holds — and is a `confirmAction` on the page.
  The switch is an update, never an upsert: Postgres checks a proposed insert row's
  constraints before it finds the conflict, and that row's defaults have no rules.
- The plan and monthly bid allowance (D-030, docs/02 T-03) are entered on the platform
  account in Settings, with the day recorded stored beside them. "Connect
  Freelancer.com" is a disabled button with its reason (C-02): the state and the reason
  are the behaviour, and the test asserts both, so it is not a dead control.
- An action's success message stays on screen while the list refreshes underneath it
  (a "Loaded N" message replacing "Approved X" is the kind of thing a person reads as
  "did it happen?").
- A stale board claim is one with no push for an hour (D-034, made at the start of this
  ticket).

Reason:

- The acceptance is "every button audited per 05; Playwright covers every button and
  form". Each page has `docs/audit/<page>.md` listing every control with its test, and
  `e2e/<page>.spec.ts` answers the API and Supabase at the network edge with the shapes
  the real routes return, which are themselves proven against real Postgres in
  `apps/api/src/routes/pages.test.ts` (dashboard figures hand-worked; approve, reject,
  edit and bulk as owner, operator, viewer and stranger; live mode refused then allowed;
  the plan dated in South African time).
- The token cache is a minute because a page's first paint makes several requests at
  once; a revoked session lasting up to a minute longer is the trade, recorded.
- `visually-hidden` inside a table header escaped the table's own scroll box and made
  the document scroll sideways at 380 px; the action columns now have visible headers.

## D-036 — Every ticket is built, blocked or not; what waits on the owner is marked BUILT-PENDING-CREDENTIALS

Date: 23/09/2026
Decided by: the owner's instruction of 23/09/2026, applied by Claude Code (session …V4PPWs)

Decision:

- A ticket blocked on a credential, an account, a host or an owner's figure is built in
  full anyway: against fakes in tests, and local stand-ins for development (a local Redis,
  PGlite for Postgres, a scripted model, an in-process fake of each marketplace API). The
  real service is chosen by configuration, so a credential dropped into `.env` is the only
  change needed.
- Its board status is BUILT-PENDING-CREDENTIALS, and the row names the clause still open
  and the docs/02 item that closes it. It moves to DONE when that clause is proven with the
  real thing.
- Stand-ins are never defaults in production. With no credential the production path
  refuses and says which one is missing. It never falls back to the fake.
- Nothing in docs/01 rule 6 changes. Figures, fees, legal wording and plan limits stay
  the owner's; the code carries the mechanism and a null. LIVE_MODE stays false. Every
  marketplace endpoint is cited from its official documentation, or the call is not
  written.
- A phase-end ticket (ARB-099, 299, 399) no longer holds back the next phase's features:
  those are built on top of what exists. The phase tag itself still waits for its four
  links, including a live preview URL (docs/01 section K). No tag is pushed without them.
- A ticket that runs past an hour pushes a green intermediate commit, so its claim never
  looks stale under D-034.

Reason:

- The owner asked for the product to be ready for its credentials, not waiting for them.
  Building against stand-ins now means the owner's answers are configuration, not new
  work.

## D-037 — `docker compose up` is proven healthy in CI; the images can be pointed at a mirror

Date: 23/09/2026
Decided by: Claude Code (ARB-004, session …V4PPWs)

Decision:

- CI has a `compose` job that runs `docker compose up -d --wait` on every push, which
  exits non-zero unless every service's own health check passes. That is ARB-004's
  clause, proven on GitHub's runners.
- `pnpm compose:up` runs the same command locally.
- `REDIS_IMAGE` and `POSTGRES_IMAGE` override the two images. Unset, the images are the
  ones compose names. This lets a registry mirror stand in where Docker Hub is out of
  reach or rate-limited.

Reason:

- The build container now starts a Docker daemon, which V-01 said it could not.
  `docker compose up --wait` of the Redis service from `mirror.gcr.io` was healthy there,
  and the worker queue tests (101) passed against it. The Postgres image cannot be pulled
  there: Docker Hub answered 429, and the download hosts of Docker Hub, GitHub's registry
  and AWS's public registry are refused by that container's egress policy. GitHub's
  runners have none of these limits, so the whole stack is checked there instead.
- The Postgres service follows the image's own set-up: its init script runs as
  `supabase_admin` (the image's default `POSTGRES_USER`) and creates the `postgres` role
  with `POSTGRES_PASSWORD`. Overriding `POSTGRES_USER` made that script fail (CI run 54:
  role "supabase_admin" does not exist). The database is `postgres` on port 54322, the
  name and port the Supabase CLI uses locally, so one `DATABASE_URL` fits either.

## D-038 — Database types are generated from the migrated schema; `pnpm db:reset` resets the compose Postgres

Date: 23/09/2026
Decided by: Claude Code (ARB-010, session …V4PPWs)

Decision:

- `packages/db/src/typegen.ts` reads the migrated schema (tables, columns, enums and
  foreign keys from `information_schema` and `pg_catalog`). From that it writes
  `packages/db/src/types.generated.ts` in the shape `supabase gen types typescript`
  emits. `packages/db/src/typegen.test.ts` fails whenever the committed file differs
  from what the migrations produce. `pnpm db:types` rewrites the file.
- `pnpm db:types:supabase` is the drop-in for a hosted project. It runs
  `supabase gen types typescript --linked` and needs B-06.
- `pnpm db:reset` runs `scripts/db-reset.sh`. That script recreates the compose Postgres
  with an empty volume (`arbitron-postgres-data`, now named outright), then runs
  `pnpm db:migrate` and `pnpm db:seed`. It never touches a hosted project.
- The old script ran `supabase db reset`, which could not work: the repository has no
  `supabase/` directory, and the migrations live in `packages/db/migrations`.
- `pnpm db:seed` pipes `buildSeedSql()` (ARB-013) into `psql`. `tsx` is a new root dev
  dependency so the script can run the TypeScript seed builder.

Reason:

- ARB-010 asks for generated types to be committed. Waiting on B-06 would leave the app
  typed by hand. The same schema, read back from the database the tests migrate, gives
  the same types now, and the test keeps them honest after every migration.
- The migrations apply cleanly to the `supabase/postgres` image in CI (run 55, compose
  job). `db:reset` itself has not yet run in CI; docs/HANDOFF.md names that as the next
  step.

## D-039 — This session works on a branch with a draft pull request; its claims are on that branch

Date: 23/09/2026
Decided by: Claude Code (session …tJv8)

Context:

- Every earlier session pushed straight to `main`, and the board's IN PROGRESS claim on
  `main` is the lock between sessions (D-034). This session's environment allows pushes
  to `claude/beautiful-tesla-b6goej` only, and no one has given permission to push to
  `main`.

Decision:

- Work lands on `claude/beautiful-tesla-b6goej`, one commit series per ticket, with
  draft pull request #4 open against `main`. The branch's copy of the board carries this
  session's claims, and the pull request lists them.
- Before each ticket, `main` is merged into the branch, and any ticket claimed or closed
  on `main` since is skipped.
- On a non-main branch CI cancels a superseded run (D-008). So the run that proves a
  ticket can be the one on a later commit, as long as that commit contains the ticket.
  The board names the run and the commit.

Reason:

- The environment's rule is explicit. The owner can merge #4, or allow pushes to `main`,
  and nothing here needs to change for either.

## D-040 — Retention runs daily at 02:00 SAST from one BullMQ scheduler; the privacy notice is the owner's file, pending or approved

Date: 23/09/2026
Decided by: Claude Code (ARB-015, session …tJv8)

Decision:

- The workers get a `retention` queue. It is not one of docs/01 section E's workers, but
  ARB-015 asks for a scheduled job. `scheduleRetention` upserts one BullMQ job scheduler
  with the fixed id `retention-daily` and the pattern `0 0 * * *`: 00:00 UTC, which is
  02:00 SAST all year (D-024). Every worker process may call it, and there is still one
  schedule. The processor runs `purgeAll` (D-017) and returns the counts. Each org's
  outcome is also an event.
- The privacy notice's wording is not written by the build (docs/01 rule 6, T-06). It is
  published as `apps/web/src/public/privacy-notice.json`, which the page fetches. The file
  is either `{"status":"pending"}` with no wording, or `approved` with `approvedBy`,
  `approvedOn`, `version` and sections. `parsePrivacyNotice` in `@arbitron/core` refuses
  a pending file that carries text, and an approved one without its approval. So a draft
  cannot be published by accident, and the page shows nothing from a file that breaks
  the rule. A unit test checks the committed file.
- `docs/privacy-data-inventory.md` lists, from the migrations, the personal information
  stored and what the retention job does to it. It ends with the questions the job
  cannot answer: whether briefs and the client fields on jobs are redacted too. They are
  not, today.

Reason:

- A fixed UTC pattern needs no time-zone database on the host, and a quiet hour keeps the
  run away from the working day.
- Keeping the wording in a file the owner edits means T-06's answer is a content change
  with no code change. The page is static, so it works on any host (C-03).

## D-041 — Marketplace tokens live in Supabase Vault, not pgsodium columns; a connect is bound to the person by a single-use attempt row

Date: 23/09/2026
Decided by: Claude Code (ARB-020, session …tJv8)

Decision:

- docs/01 section C names pgsodium for token encryption. Supabase now marks pgsodium
  "pending deprecation" and points to Vault
  (https://supabase.com/docs/guides/database/extensions/pgsodium;
  https://supabase.com/docs/guides/database/vault). So migration 0017 drops the two
  `bytea` token columns from `platform_accounts` and stores each account's access and
  refresh token as a Vault secret, keeping only the two secret ids on the row.
- Reading tokens back (`app.platform_tokens`) is `service_role` only: a signed-in person
  can connect and disconnect an account but never see a token. Connecting and
  disconnecting go through `app.connect_platform_tokens` and
  `app.disconnect_platform_account`, which check `app.can_write` for the account's org.
  Disconnecting deletes the secrets and marks the row `disconnected`; the row and its
  history stay.
- The test databases (PGlite, plain Postgres) have a `vault` schema shim with the same
  functions and no encryption (`packages/db/src/testing.ts`). CI's compose job runs
  `scripts/db-verify-vault.sql` against the real `supabase/postgres` image and fails
  unless the stored secret is unreadable in `vault.secrets`, decrypts to the value
  written, is refused to `authenticated`, and is gone after a disconnect. This clears
  V-02 (run 72).
- Freelancer.com documents no `state` parameter on its authorise endpoint
  (https://developers.freelancer.com/docs/authentication/generating-access-tokens). A
  connect therefore starts with a `platform_connect_attempts` row for the person, valid
  for ten minutes. The returning code is accepted only while that person has an unused
  attempt, and the callback uses up every open attempt of theirs before it tries the
  code, so a code is never tried twice, even when the exchange fails.

Reason:

- Vault is the mechanism Supabase says to use, and it does what section C asks of
  pgsodium: authenticated encryption with the key held outside the database.
- Without `state`, the attempt row is the only thing that ties a code arriving at the
  callback to a person who asked for it, and expiring it keeps a stale link from
  connecting an account later.

## D-042 — Work reaches main through one pull request per ticket, merged as soon as CI is green; claims go straight to main

Date: 23/09/2026
Decided by: the owner's instruction of 23/09/2026, applied by Claude Code (session …tJv8).
It replaces D-039.

Decision:

- Pull requests #1 to #4 were merged into `main`, oldest first, and their `claude/`
  branches deleted. #1 was a second ARB-062. `main` already held ARB-062, including #1's
  API export, taken with credit, so its conflicts were resolved to `main`'s version.
  Only its tested DD/MM/YYYY parser, which did not conflict, was kept. #2 and #3 were
  run-log entries, placed in date order.
- From now on each ticket is built on a branch and opened as a pull request. The PR is
  merged into `main` as soon as its CI is green, and the branch is then deleted. `main`
  is the only branch that matters.
- A claim is a one-line board change pushed straight to `main` before the ticket starts,
  so the hourly routine sees it (D-034 still applies).
- The web app deploys to Vercel from `main` (ARB-070). Where a credential is missing it
  runs in demo mode, so every page can be viewed.

## D-043 — Without its credentials the web app deploys in demo mode, answered inside the browser, and says so on every page

Date: 23/09/2026
Decided by: the owner's instruction of 23/09/2026 ("where real credentials are missing,
run the app in its fake/demo mode so every page is viewable"), applied by Claude Code
(ARB-070, session …tJv8)

Decision:

- `vite build --mode demo` (`pnpm build:web:demo`) injects `src/demo/demo.js` ahead of
  every page's own script. It replaces `fetch` for two hosts only, the stand-in Supabase
  and API hosts in `/.env.demo`. It answers them inside the browser:
  - Supabase Auth: any email and password sign in, as the sample person "Demo Owner".
  - The API: every route the pages call, in the shapes the real routes return, from
    sample data kept in the tab's sessionStorage. The form rules are `@arbitron/core`'s,
    the same ones the API runs, so live mode stays off until every rule is set, exactly
    as in the real app.
- Every sample row is marked "(sample)". A banner on every page says: "Demo mode: sample
  data only. Nothing is saved to a server or sent to a marketplace, and no figure is a
  real price, fee or client." It has a control to reset the sample data. Price bands stay
  empty, as they are in the real app (D-14).
- Only the demo build contains this code. CI checks that the e2e build, a real build with
  stand-in hosts, carries none of it. D-036 holds: a real deployment cannot fall back to
  sample data.
- On Vercel, `scripts/build-web-vercel.sh` builds the real app when SUPABASE_URL,
  SUPABASE_ANON_KEY and API_URL are set in the project's environment, and demo mode
  otherwise. Adding the three variables and redeploying is the whole switch.

Reason:

- The owner wants every page viewable now, and the sign-in and API hosts do not exist yet
  (B-06, B-12). A demo that runs in the browser needs no server that could be mistaken
  for the product.

## D-044 — Connecting a Freelancer.com account: scopes 1, 2, 5 and 6; not gated by LIVE_MODE; a callback page of its own; demo mode connects a sample account

Date: 23/09/2026
Decided by: Claude Code (ARB-020, session …tJv8)

Decision:

- The authorise request asks for `scope=basic` and the advanced scopes 1 (create
  projects), 2 (manage projects), 5 (messaging) and 6 (user information), each cited in
  `packages/freelancer/src/oauth.ts` from the official scope table. These cover Phases
  1 to 3 (bids, sourcing posts, the inbox). No wider scope is asked for.
- Connecting is not an outbound action to a client or a marketplace listing, so
  `LIVE_MODE` does not gate it. The sandbox connect is the ticket's acceptance clause,
  and nothing else in the product can reach Freelancer.com until an account is
  connected. The submit worker's own gate (D-032) is unchanged.
- The redirect lands on a page of its own, `freelancer-callback.html`
  (`FREELANCER_REDIRECT_URI`). It hands the code to the API, clears it from the address
  bar and the history, says which account was connected, and links back to Settings. The
  browser never sees a token.
- One connected account per org and per verified identity. A second org connecting the
  same identity is refused by the unique constraint, reported in words. Connecting a
  different identity while one is connected is refused with "Disconnect it first".
  Reconnecting the same identity, or any identity after a disconnect, reuses the row.
- In demo mode (D-043) Connect returns at once with a sample account named
  "sample-account (demo)" and nothing reaches Freelancer.com; the hint beside the button
  says so.

Reason:

- Asking for the four scopes once means the owner consents once, not again per phase.
- Gating the connect on LIVE_MODE would make the sandbox clause untestable with the
  switch off, which is the only way it is ever run before go-live.

## D-045 — The ingest worker keeps one schedule per scanner from a minute-by-minute sync; a listing is one row per org; a rate limit is the queue's backoff

Date: 23/09/2026
Decided by: Claude Code (ARB-022, session …tJv8)

Decision:

- The `ingest` queue runs two kinds of job. A `sync` every minute, from one fixed BullMQ
  job scheduler, reads the active Freelancer.com scanners whose org has a connected
  account and keeps one job scheduler per scanner at the scanner's own interval
  (`scanner:<id>`, `every` = its seconds). A `poll` per scanner, at that interval, is one
  call to the documented search. Adding, editing, pausing or deleting a scanner in
  Settings takes effect within a minute, and the API tells Redis nothing.
- The search is `GET /projects/0.1/projects/active/`, cited in
  `packages/freelancer/src/projects.ts` parameter by parameter. Scanner filters map to
  it as far as it goes: keywords to `query` (every term must match, the endpoint's own
  rule), the hourly switch to `project_types[]`, included countries to `countries[]`, a
  USD budget floor to `min_price` (which the docs define in USD). A floor in another
  currency is applied to listings priced in that currency, and a listing in a third
  currency is kept, since comparing them needs a rate the worker does not have.
  Excluded countries and category slugs cannot be applied (the endpoint filters by
  country only inclusively and the listing carries no client country; the slugs are the
  org's own taxonomy, which the estimate worker classifies into), and each run's
  `scanner.polled` event names the filters it did not apply.
- Migration 0018 makes the dedupe key per org: `unique (org_id, platform, external_id)`.
  The upsert refreshes what the marketplace changes (title, text, budget, bids) and keeps
  what the org added (scanner, category). A listing seen for the first time is a
  `job.ingested` event and a score job; one seen again is neither.
- `bid_stats.bid_avg` stays in `jobs.raw` only: the docs do not say which currency it is
  in, so `average_bid_minor` is left null rather than guessed.
- A 429 (`AuthorisationExceptionCodes.RATE_LIMITED`, with the `RateLimit-*` headers) is
  logged as `external.call` and thrown back to the queue: ARB-030's exponential backoff
  is the wait, and a run that fails every attempt is a dead letter. A refused token (401
  or 403) marks the account `expired`, is logged, and is not retried: the owner connects
  again in Settings.
- The listing's client fields (`client_country`, `client_payment_verified`,
  `client_spend_minor`, `client_rating`) stay null. The search's `user_details`
  projection is documented only as "basic user information"; its shape is for the sandbox
  run to show (C-02).

Reason:

- A sync that owns the schedules is idempotent and needs no coupling between the API and
  the queues, and one scheduler per scanner is exactly "per scanner interval" (docs/01
  section E).
- A per-org key is what every later table assumes: each org has its own scores,
  estimates and bids for the same public listing.

## D-046 — The inbox is read every two minutes per connected account from the documented thread and message lists; the account's own marketplace messages are stored as observed, not sent; the operator alert is a plain Telegram card

Date: 23/09/2026
Decided by: Claude Code (ARB-120, session …tJv8)

Decision:

- The `inbox-sync` queue runs on the ingest worker's pattern (D-045): a sync every minute
  keeps one job scheduler per connected Freelancer.com account, every two minutes, and a
  poll per account reads `GET /messages/0.1/threads/` for `project` threads updated
  since five minutes before the last point reached, then `GET /messages/0.1/messages/`
  for those threads, both cited parameter by parameter in
  `packages/freelancer/src/messaging.ts`. Two minutes is this product's interval, not a
  figure from the docs; five minutes of overlap costs a few repeated rows, which the
  unique keys turn into no-ops, and misses nothing that arrived late.
- Only `project` threads are read. A bid opens a project thread, and every thread the
  product acts on has a job behind it; a thread's project context id is matched to
  `jobs.external_id` within the org to link them. `general` and `contest` threads are
  left where they are.
- A message the account itself wrote on Freelancer.com is stored outbound with
  `messages.origin = 'platform'` (0019). 0003's rule that no outbound message leaves
  without an approval record now reads "no outbound message the app sends": an observed
  message was sent by the owner on the site, not by the app, and ARB-122's gate is
  untouched.
- A message with no text and attachments is stored as "(N attachments, not
  downloaded)": the docs list the attachment endpoints, and downloading is not asked for.
- The thread's status follows its newest message: `awaiting_operator` after a client
  message, `awaiting_client` after the account's own; a `closed` thread stays closed.
- The client's handle is the `user_details` projection's `username`, else its
  `display_name`, else the member id. The threads list's envelope (`result.threads`,
  `result.users`) is not shown on the docs page and follows the API's other lists; it is
  the first thing the sandbox run confirms (C-02).
- The alert is `apps/telegram`'s `notifyInbound`: "New client message / From / About"
  and up to 400 characters of the text, to every linked owner or operator chat in the
  org, with no buttons. The worker takes it as a dependency and never imports the bot.

Reason:

- Reading by "updated since" with an overlap and unique keys is idempotent, which docs/01
  section E requires of every worker, and needs no per-thread cursor.
- Marking observed messages as such keeps the approval constraint honest without
  fabricating an approval for a message nobody in the app approved.

## D-047 — The auto-reply is one per org, saved with its approver; it goes to the first client message on a thread nobody has answered while no message has left the org for the period; live-gated like a bid

Date: 23/09/2026
Decided by: Claude Code (ARB-121, session …tJv8)

Decision:

- One auto-reply per org ("First reply", `auto_replies`), set on the settings page by an
  owner or operator (0008 lets an operator write the table). The person who saves it is
  recorded as its approver (`approved_by`, 0020), and every reply the worker writes
  carries that approval as `messages.approved_by` with `approved_via = 'auto'`, so
  0003's rule that nothing outbound leaves without an approval record holds. The wording
  is the owner's (docs/02 D-08); the build ships none.
- The `auto-reply` worker takes one job per new inbound message, queued by the inbox
  sync. It sends only when, in order: the message is inbound on an open thread; an
  active, approved auto-reply exists; the thread has had no auto-reply (0006's unique
  key on the thread is the guarantee) and no reply of any kind; and the operator is
  offline, meaning no message has left the org, from the app or from the marketplace,
  for `offline_after_minutes` (`operatorIsOffline` in `@arbitron/core`).
- The record comes first: the outbound message row and the `auto_reply_sends` row are
  written before the live gate is checked, so a thread is marked done with its one reply
  whether or not the reply could leave. With either switch off (D-032) the row stays
  unsent and `external.blocked_by_live_mode` carries the text and the thread. Live, the
  reply is posted with `POST /messages/0.1/threads/{thread_id}/messages/`, `message` on
  the URL as the docs' walkthrough sends it; a platform failure undoes both rows and
  throws, so the queue's backoff tries again, and a refused token is final.
- Each run is an `auto_reply.sent` event with its outcome and reason.

Reason:

- Recording before sending is what makes "once per thread" true under retries and
  concurrent workers; undoing on failure is what keeps a failed send from counting.
- "Offline" as "nothing has left the org for the period" needs no presence tracking
  and reads the same rows the inbox sync already keeps.

## D-048 — An outbound message is drafted on its thread, waits on the approvals page beside the bids, and leaves only through the send-message worker's live gate; its state is read from its columns

Date: 23/09/2026
Decided by: Claude Code (ARB-122, session …tJv8)

Decision:

- A reply is an app-written outbound message (`origin = 'app'`, 0019) on a thread,
  drafted with `POST /v1/threads/:id/messages` by an owner or operator. Its state is
  not a column: sent when `sent_at` is set, else rejected when `rejected_at` is set,
  else failed when `failure_reason` is set, else approved when `approved_by` is set,
  else queued (`outboundMessageState` in `@arbitron/core`; 0021 adds the two columns).
- The approvals page lists queued replies beside queued bids, with the last client
  message quoted, and the same three actions with the bids' rules (D-033): approve
  names the person (0009's restrictive policy makes it the caller's own name) and hands
  the message to the `send-message` queue; edit clears the approval, and a rejection
  too, because the old approval covered the old words; reject records its reason; a sent
  message can be changed by none of them. Each is an event: `message.drafted`,
  `message.approved`, `message.edited`, `message.rejected`, `message.sent`.
- The `send-message` worker (a queue not in docs/01 section E, added as the retention
  queue was) sends one approved message: rejected or unapproved is skipped and said so;
  the live gate (D-032) with either switch off leaves it unsent with
  `external.blocked_by_live_mode` carrying the text and the thread; live, the documented
  `POST /messages/0.1/threads/{thread_id}/messages/` call, then `sent_at`, the
  marketplace's id and the thread's status. A rate limit, a 5xx or a network failure
  goes back to the queue; a bad token or another 4xx is final and is written to the row
  as its failure, with what to do next.
- 0003's constraint is the last line: `sent_at` on an app message without
  `approved_by` and `approved_via` is refused by the database, whoever writes it, and
  the tests show it.

Reason:

- Deriving the state from the columns that already hold the facts means no column can
  disagree with them, and the auto-reply's rows (D-047) read correctly without change.
- One worker per outbound path keeps the live gate in one place per path, on the submit
  worker's pattern, so a reviewer finds it where they expect it.

## D-049 — Discovery: section F's ten questions as versioned data, three at a time, the batch a template the operator approves, the reply read by the model into answers only when confident

Date: 23/09/2026
Decided by: Claude Code (ARB-130, session …tJv8)

Decision:

- The question set is `DISCOVERY_QUESTIONS` in `@arbitron/core`, version "1": docs/01
  section F's ten questions in its words and order. A session records the version it
  was started with (`discovery_sessions.question_set_version`), so a later set does not
  change what an old session means.
- A batch is three questions: the open ones, those never put to the client first, and
  always fewer than the whole set (the size is capped below ten in code, so "never all
  at once" cannot be configured away). `asked` (0022) records when each question was
  put to the client.
- The batch put to the client is not written by the model. It is a fixed template: a
  greeting with the client's handle, the questions numbered, "Short answers are fine."
  It is drafted as an outbound message of the app and waits on the approvals page like
  any other (D-048), where the operator edits and approves it.
- The model's job is reading. On each client reply the discovery worker asks it, against
  `DISCOVERY_EXTRACT_SCHEMA` with one retry (D-011's rule for every model call), which
  open questions the reply answers, each with a confidence. Only readings at 0,6 or
  above, for questions still open, are written as answers, marked `client`; a question
  already answered is never overwritten by the model. An operator's own capture
  (`PATCH …/discovery/answers`) may overwrite anything and is marked `operator`.
- Completeness is answered questions over ten, to two decimals, recomputed on every
  capture and carried in each `discovery.updated` event.
- A session is started by the operator, not on every reply: a thread without one is left
  alone by the worker.

Reason:

- Fixed wording for the questions keeps every session comparable and keeps the model from
  inventing questions; the operator still edits the draft before it goes.
- A confidence floor and "never overwrite" make a wrong reading cost at most a re-ask,
  never a lost answer.
