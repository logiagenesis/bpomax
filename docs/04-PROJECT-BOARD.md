# 04 — PROJECT BOARD

Document: LI-BOARD-ARB-0926 v1.0 — 22/09/2026
Live board: Claude Code updates Status and SHA on every ticket and pushes.
Status values: TODO / IN PROGRESS / BLOCKED / DONE.
Blocker references point to 02-BLOCKERS.md.

## Phase 0 — Repository and foundations

| ID | Ticket | Depends | Blockers | Acceptance criteria | Status | SHA |
|---|---|---|---|---|---|---|
| ARB-001 | Create private repo `logiagenesis/arbitron`, push /docs to main | — | B-01, B-02 | Repo URL opens; /docs present on main; remote SHA = local HEAD | DONE | 05b9769 |
| ARB-002 | Monorepo scaffold (pnpm workspaces, apps/*, packages/*), lint, typecheck, prettier | 001 | — | `pnpm install && pnpm lint && pnpm typecheck` pass on clean clone | DONE | 7ff144c |
| ARB-003 | GitHub Actions CI: lint, typecheck, Vitest, Playwright on push and PR | 002 | — | Green check on main; failing test turns CI red (proved with a throwaway branch) | DONE (green: run 6 on main; red: run 5 on branch `ci-red-proof`) | 4dddeb8 |
| ARB-004 | docker-compose for Redis and local Supabase; `.env.example` complete per 01 section J | 002 | — | `docker compose up` healthy; every variable in 01-J present in .env.example | BLOCKED (V-01: compose start unverified, no Docker daemon in build container; .env.example clause proven by test) | c194e1c |
| ARB-005 | README (setup, run, deploy, links section), DECISIONS.md created | 002 | — | Fresh machine can follow README to running app | DONE | e0f8c85 |

## Phase 1 — Find, qualify, price, bid, approve

| ID | Ticket | Depends | Blockers | Acceptance criteria | Status | SHA |
|---|---|---|---|---|---|---|
| ARB-010 | Supabase migrations: tenancy, marketplace, money, events, settings tables per 01-D | 004 | B-06, D-05 | `pnpm db:reset` applies cleanly; generated types committed | BLOCKED (C-01: generated types need a Supabase project, B-06. Migrations themselves apply cleanly — verified against real Postgres via PGlite on every push) | 8c9c8fa |
| ARB-011 | RLS policies on every table + tests proving cross-org read/write is denied | 010 | — | Test suite shows denial for other org on every table | DONE | ecfc49e |
| ARB-012 | Auth (Supabase email login), roles owner/operator/viewer | 010 | D-13 | Viewer cannot approve; operator can; owner can change settings | DONE (acceptance proven in full; the hosted sign-in round trip itself is unverified — V-03. The login page is ARB-061.) | f34a587 |
| ARB-013 | Seed service_categories and seed market_price_bands flagged source='seed' | 010 | — | Seed idempotent; seed bands visibly labelled "seed" in UI | BLOCKED (D-14: no band figures exist to seed and none are invented, since ARB-040 prices real bids off the p50. The taxonomy is seeded with the 22 categories, idempotently, checked against the spec's own list; every band the generator writes is flagged source='seed'. The UI label is ARB-061.) | c21c34e |
| ARB-014 | events audit log writer + viewer API | 010 | — | Every state change in later tickets writes an event (verified by tests) | DONE (writer, reader and `GET /v1/events` built and tested; the "every state change" half is a standing obligation each later ticket carries, not something this one can close) | 8b18d29 |
| ARB-015 | Data retention job and privacy notice page | 010 | T-06 | Retention period from T-06 enforced by scheduled job with test | BLOCKED (T-06: the period is a legal answer and is not guessed — `settings.retention_days` has no default and live mode is now refused without it. The job is built and tested: it stands down with no period, and with one it redacts closed, expired conversations only. The privacy notice needs T-06's text and ARB-060; no legal wording is invented here.) | 447e6a9 |
| ARB-020 | Freelancer.com OAuth connect (sandbox first), encrypted token storage, one-account-per-identity rule | 012 | B-03, B-04 | Connect and disconnect work in sandbox; tokens encrypted at rest; second account for same identity rejected | BLOCKED (C-02: no Freelancer.com developer app or sandbox accounts, B-03/B-04) | |
| ARB-021 | Scanner CRUD (filters, interval, active, auto_send off, daily cap) | 020 | D-06 | Create/edit/delete via API and UI; validation on every field | DONE via API (create/edit/delete, 14 validation cases, auto-send guardrail checked against the scanner as it will be after the edit). The UI half is ARB-061. D-06 supplies the three starting searches to seed, not the mechanism. | 02f516d |
| ARB-022 | Ingest worker: official project search, upsert, dedupe, rate-limit handling, doc URLs cited in code | 021 | B-07 | New matching sandbox/live-read jobs appear within one interval; zero duplicates after 24 h run | BLOCKED (C-02: needs a connected sandbox account, ARB-020) | |
| ARB-030 | BullMQ setup, retries, dead-letter queue, worker health endpoint | 004 | B-07 | Failed job retried with backoff then lands in DLQ; health endpoint reports queues | DONE (proven against a real Redis, locally and as a CI service container; B-07's hosted instance is only needed to deploy, ARB-070) | dc4af58 |
| ARB-031 | LLM package: provider config, JSON-schema validation, token/cost metering | 002 | B-08 | Invalid model output rejected and retried once; cost recorded per call | DONE (both clauses proven against a scripted transport, mutation-checked; prices transcribed from the published page with source and date; the Anthropic transport itself has never made a call — V-04, needs B-08) | 9e32179 |
| ARB-032 | Score worker (0–100, verdict, reasons, flags, reply probability) | 022, 031 | — | 20 fixture jobs scored; schema-valid; red-flag fixtures flagged | DONE (all three clauses proven with a scripted model that misses every flag — the flags come from rules in `packages/core/src/scoring.ts`, mutation-checked. Scores jobs already in `jobs`; the ingest that fills it is ARB-022, C-02. A real model's judgement is V-04) | SHA_032 |
| ARB-040 | Estimate worker (in-house → rate card → market band → AI-build) | 032, 013 | D-04, B-10 | Each estimate records its method; unit tests for each branch | TODO | |
| ARB-041 | Margin engine with fee table, FX buffer, min rules; every input line stored | 040 | T-02, D-02, D-03 | Hand-calculated test cases pass to the cent for fixed, hourly, multi-currency | TODO | |
| ARB-042 | Bid allowance tracking against membership plan | 041 | T-03 | Submission blocked with clear message when allowance reached | TODO | |
| ARB-043 | Draft-bid worker: templates, milestone split, real estimate in price/timeline, portfolio (own_work/labelled_demo only) | 041 | D-07, D-10 | Draft cites only real portfolio items; price equals margin output; milestones sum to bid amount | TODO | |
| ARB-044 | Submit worker: approval required, daily cap, LIVE_MODE gate, pipeline item creation | 043 | T-01, B-05 | With LIVE_MODE=false nothing is sent and the would-send payload is logged; sandbox submission succeeds | TODO | |
| ARB-050 | Telegram bot: link via one-time code, /queue /pause /resume /stats, Approve/Edit/Reject cards | 043 | B-09 | Approve from Telegram submits in sandbox; Edit replaces text; Reject records reason | TODO | |
| ARB-060 | Web design system (tokens, components, 380 px responsive, UK English, DD/MM/YYYY) | 002 | D-11 | Style guide page renders every component; Playwright visual snapshot stored | TODO | |
| ARB-061 | Pages: login, dashboard, feed, approvals, settings (accounts, scanners, margin rules, fee table, FX, live-mode switch with confirm) | 060, 044 | — | Every button audited per 05; Playwright covers every button and form | TODO | |
| ARB-062 | Audit log page | 014, 060 | — | Filter by type/date/actor; export CSV | TODO | |
| ARB-070 | Deploy web to chosen host with preview per push; deploy API/workers/bot | 061 | B-11, B-12 | Live preview URL and API health URL recorded in README; Telegram webhook reachable | TODO | |
| ARB-099 | Phase 1 audit + tag `phase-1` + phase report with four links | all Phase 1 | — | Report contains repo URL, latest commit URL, tag URL, live preview URL | TODO | |

## Phase 2 — Contact, discovery, brief, sourcing

| ID | Ticket | Depends | Blockers | Acceptance criteria | Status | SHA |
|---|---|---|---|---|---|---|
| ARB-120 | Inbox sync: threads and messages from connected account | 099 | T-01 | New sandbox message appears in app within one interval and alerts Telegram | TODO | |
| ARB-121 | Auto-reply once per thread when operator offline | 120 | D-08 | Second inbound message never triggers a second auto-reply (test) | TODO | |
| ARB-122 | Outbound messages require approval; LIVE_MODE gate | 120 | — | No message leaves without approval event (test) | TODO | |
| ARB-130 | Discovery sessions: versioned question set, batched questions, completeness % | 122 | — | Completeness updates as answers are captured; questions never sent all at once | TODO | |
| ARB-131 | Brief builder: structured brief per 01-F, validation, lock/version | 130 | — | Brief cannot lock with missing required fields; versions preserved | TODO | |
| ARB-140 | Conversations page (threads, discovery, brief) | 131, 060 | — | Every button audited; Playwright coverage | TODO | |
| ARB-200 | Supplier database + rate cards + CSV import/export with template | 099 | D-09 | CSV template downloadable; import validates every row with line-numbered errors | TODO | |
| ARB-201 | Sourcing request from locked brief; rank existing suppliers (category, rate, turnaround, quality, time zone) | 131, 200 | — | Ranking deterministic and explained per supplier | TODO | |
| ARB-202 | Sourcing post drafts (Freelancer employer project; Upwork/Fiverr drafts for manual posting) | 201 | T-02 | Drafts contain brief scope only, no client-identifying data | TODO | |
| ARB-203 | Post sourcing project via Freelancer API after approval (LIVE_MODE), collect candidate bids | 202 | T-01, T-02 | Sandbox employer project created; candidate bids stored with country and price | TODO | |
| ARB-204 | Reprice with real candidate quote; update margin; alert if below rule | 203, 041 | — | Margin recalculated and change logged; alert fires on breach | TODO | |
| ARB-210 | Sourcing and suppliers pages | 204, 060 | — | Every button audited; Playwright coverage | TODO | |
| ARB-299 | Phase 2 audit + tag `phase-2` + phase report with four links | all Phase 2 | — | As ARB-099 | TODO | |

## Phase 3 — Delivery, money, learning, Upwork, MCP

| ID | Ticket | Depends | Blockers | Acceptance criteria | Status | SHA |
|---|---|---|---|---|---|---|
| ARB-300 | Upwork read-only job ingest via official API | 299 | B-14, T-04 | Jobs ingested with source=upwork; no browser automation anywhere in codebase (grep check in CI) | TODO | |
| ARB-310 | Delivery orders, milestones, supplier handover checklist | 299 | T-05 | Milestone totals reconcile to agreed cost | TODO | |
| ARB-311 | Payments in/out with FX rate used; realised margin | 310 | B-10 | Realised margin matches hand calculation in tests | TODO | |
| ARB-312 | Retainer tracking and monthly total | 311 | — | Dashboard retainer total equals sum of active retainers | TODO | |
| ARB-320 | Analytics rollup and page (reply rate, win rate, cost per reply, realised margin by category/template/supplier/scanner) | 311 | — | Figures verified against raw SQL in tests | TODO | |
| ARB-330 | MCP server with tools per 01-I; README setup for Claude Desktop/Code | 299 | — | Each tool callable in an automated test | TODO | |
| ARB-340 | Templates page with A/B variants and reply rates | 320 | — | Reply rate = replies/sends verified | TODO | |
| ARB-399 | Phase 3 audit + tag `phase-3` + phase report with four links | all Phase 3 | — | As ARB-099 | TODO | |

## Phase 4 — SaaS

| ID | Ticket | Depends | Blockers | Acceptance criteria | Status | SHA |
|---|---|---|---|---|---|---|
| ARB-400 | Public sign-up, org creation, onboarding | 399 | D-01, B-15 | New org isolated from Logi-Ink org (RLS tests) | TODO | |
| ARB-410 | Plans, limits, usage counters, 80%/100% alerts | 400 | D-12, B-13 | Limit reached blocks action with message; alerts sent | TODO | |
| ARB-420 | Paystack (ZAR) and Stripe (USD) billing with webhooks | 410 | B-15 | Test-mode checkout activates plan; failed payment downgrades after grace period | TODO | |
| ARB-430 | Affiliates and attribution | 420 | — | Referral code tracked from click to paid subscription | TODO | |
| ARB-440 | Marketing site (static, Vite) — factual copy only, no fake scarcity | 400 | D-01, 03 assets | Copy audit passes; Lighthouse ≥ 90 on all categories | TODO | |
| ARB-499 | Phase 4 audit + tag `phase-4` + phase report with four links | all Phase 4 | — | As ARB-099 | TODO | |
