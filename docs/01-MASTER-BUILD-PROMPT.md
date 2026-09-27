# 01 — MASTER BUILD PROMPT (Claude Code)

Document: LI-PROMPT-ARB-0926 v1.0 — 22/09/2026
Owner: Logi-Ink (Pty) Ltd
Supersedes: every earlier Arbitron prompt or brief. Files in /reference are background only.

How to use:
1. Clear every item marked HARD in 02-BLOCKERS.md first.
2. Put the image assets from 03-IMAGE-GENERATION.md into a folder `brand-assets/` next to this file (optional for Phase 1; placeholders are generated if absent).
3. Open Claude Code in an empty folder. Copy this whole package (all numbered files + /reference + /brand-assets) into that folder as `/docs`.
4. Paste everything inside the code block below as the first message.

```
You are the lead engineer for ARBITRON (working name), a freelance-marketplace arbitrage platform owned by Logi-Ink (Pty) Ltd, South Africa. The full specification is in /docs. Read these files completely before writing any code, in this order: /docs/00-README.md, /docs/01-MASTER-BUILD-PROMPT.md (this spec, sections A–M below the prompt block), /docs/02-BLOCKERS.md, /docs/04-PROJECT-BOARD.md, /docs/05-AUDIT-PROTOCOL.md. Treat /docs/reference/* as background only; where it conflicts with the numbered docs, the numbered docs win.

NON-NEGOTIABLE DELIVERY RULES
1. Nothing exists unless it is pushed to GitHub. First action after reading the docs: create the private repository `logiagenesis/arbitron` with `gh repo create logiagenesis/arbitron --private --source=. --remote=origin`, commit /docs, push to `main`. If `gh auth status` fails, STOP and print the exact command the owner must run (`gh auth login`), then wait.
2. Push after every ticket. Commit message format: `ARB-xxx: <summary>`. After each push run `git ls-remote origin main` and confirm the remote SHA equals the local HEAD SHA. If they differ, fix before continuing.
3. Every phase ends with a git tag (`phase-1`, `phase-2`, …) pushed to origin and a deployed, clickable preview URL for the web app (see section K).
4. You may never write "done", "complete" or "finished" without, in the same message: the GitHub repository URL, the commit URL of the latest pushed commit, the tag URL for the phase, and the live preview URL. If any of those four cannot be produced, report the phase as NOT DONE and state exactly what is blocking.
5. Keep /docs/04-PROJECT-BOARD.md as the live board: update each ticket's Status (TODO / IN PROGRESS / BLOCKED / DONE) and the commit SHA that closed it, and push that change with the ticket.

WORKING RULES
6. No guessing, no assuming. If a fact is not in /docs and cannot be verified from an official source (official API docs, official SDK, official terms page), add it to /docs/02-BLOCKERS.md under "Raised during build" with what is needed and from whom, mark the dependent ticket BLOCKED, and move to the next unblocked ticket. Record every design choice that /docs leaves open in DECISIONS.md with the reason.
7. Run the audit protocol in /docs/05-AUDIT-PROTOCOL.md for every ticket before marking it DONE. Write its checklist result into the PR/commit body.
8. Work through /docs/04-PROJECT-BOARD.md in ticket order, respecting dependencies. Do not start Phase N+1 until every non-blocked Phase N ticket is DONE and tagged.
9. Never place a real bid, send a real message to a real client, or post a real project on any marketplace during development. Use the Freelancer.com sandbox (https://www.freelancer-sandbox.com) or recorded fixtures. Live mode is enabled only by the owner setting LIVE_MODE=true.
10. At the end of every phase print a phase report: tickets done, tickets blocked with reasons, new blockers raised, test results, and the four links from rule 4.

Begin now with rule 1.
```

---

## A. Product definition

ARBITRON runs the full arbitrage loop for one operator (Logi-Ink) first, then as a paid multi-tenant SaaS:

1. FIND — pull live jobs from freelance marketplaces that match saved searches.
2. QUALIFY — score each job for fit, client quality, competition and red flags.
3. CONTACT — draft a bid designed to start a conversation; after the client replies, run a structured discovery conversation to find out exactly what they want.
4. BRIEF — turn the conversation into a structured requirements brief (scope, deliverables, deadline, budget, tech, acceptance criteria).
5. SOURCE — decide who delivers it: in-house (Logi-Ink), AI-assisted build, a supplier from our own database, or a new supplier found anywhere in the world through a sourcing post on a marketplace. Show country, time zone, rate, turnaround, quality history.
6. PRICE — estimate delivery cost and calculate margin after platform fees, supplier cost and FX. Only jobs that clear the margin rule go forward.
7. APPROVE — the operator approves bids, messages and supplier posts in one tap (Telegram) or in the web queue.
8. DELIVER — track the won job through milestones, supplier handover, client delivery and payment, both directions.
9. LEARN — realised margin, reply rate and win rate per category, template, supplier and search.

Phase 1 is internal-only for Logi-Ink. Billing and multi-tenant sign-up are Phase 4.

## B. Platforms (verified status as at 22/09/2026)

| Platform | Use | Access route | Status |
|---|---|---|---|
| Freelancer.com | Find jobs, bid, message, and post sourcing projects to hire suppliers | Official REST API v0.1 at `https://www.freelancer.com/api/`; public project search works without a token; bidding, messaging and posting need OAuth2; official Python SDK `freelancer/freelancer-sdk-python`; sandbox at `https://www.freelancer-sandbox.com` | Launch platform |
| Upwork | Find jobs (Phase 3) | Official GraphQL API with OAuth2, requires Upwork API key approval. RSS was discontinued 20/08/2024. Submission only via Upwork's agency/Business Manager model. Never automate a logged-in browser session. | Blocked until API approval (see 02-BLOCKERS) |
| Fiverr | Supplier price research and supplier sourcing | No verified buyer API. Manual CSV import only until an official route is confirmed. | Manual |

Every endpoint, parameter name, rate limit and fee used in code must be confirmed against the official docs at build time and cited in a code comment with the doc URL. If the docs cannot be reached, raise a blocker (rule 6).

## C. Architecture and stack (fixed)

- Front end: Vite, static multi-page HTML, one CSS system, vanilla JS ES modules. No React, Vue, Next or other frameworks.
- API: Node 20 LTS, TypeScript, Fastify.
- Data: Supabase (Postgres, Auth, Storage, Row Level Security on every table, pgsodium for token encryption).
- Jobs: BullMQ on Redis.
- LLM: provider-agnostic package; Anthropic as default provider; model names and prices read from config, never hard-coded.
- Notifications and approvals: Telegram Bot API (webhook).
- Email: provider chosen by owner (see 02-BLOCKERS).
- Tests: Vitest (unit and integration), Playwright (end-to-end, every page, every button).
- Package manager: pnpm workspaces.

Monorepo layout:

```
arbitron/
  apps/web        Vite static front end
  apps/api        Fastify API + MCP server
  apps/workers    BullMQ workers
  apps/telegram   Telegram webhook bot
  packages/core   domain logic: margin maths, scoring schemas, taxonomy, brief schema
  packages/db     Supabase migrations, seed, generated types
  packages/llm    LLM client, prompt templates, JSON schema validation
  docs/           this package
  brand-assets/   owner-supplied images (placeholders generated if absent)
  DECISIONS.md
  README.md
  .env.example
  docker-compose.yml   redis + supabase local
```

## D. Data model (Supabase migrations)

All tables: uuid primary key, `org_id` where tenant-scoped, `created_at`, `updated_at`, RLS policies scoped to org membership. Money stored as integer minor units plus ISO currency code. Timestamps stored in UTC; displayed SAST, DD/MM/YYYY.

Identity and tenancy: `orgs`, `users` (auth link, role owner/operator/viewer, telegram_chat_id), `memberships`.

Marketplace: `platform_accounts` (platform, external_user_id, encrypted OAuth tokens, status, last_sync_at; one account per platform per verified identity — enforce unique), `scanners` (filters jsonb, poll interval, active, auto_send false by default, daily_cap), `jobs` (platform + external_id unique, raw jsonb, normalised title, description, budget min/max, currency, hourly flag, skills, client country, payment verified, client spend, client rating, bid count, average bid, posted_at, first_seen_at), `job_scores` (score 0–100, verdict go/caution/skip, reasons, flags, reply_probability, model, token and cost usage).

Conversation and brief: `threads` (platform thread id, job, client handle, status), `messages` (direction in/out, body, sent_at, approved_by, approved_via), `discovery_sessions` (thread, question set version, answers jsonb, completeness %), `briefs` (structured requirements — see section F — version, locked flag).

Sourcing and pricing: `service_categories` (taxonomy, seeded), `market_price_bands` (p25/p50/p75 per category and currency, sample size, source, sampled_at; seed rows flagged source='seed'), `suppliers` (name, country, time zone, channel freelancer/upwork/fiverr/direct/in_house/ai_build, languages, quality score, on-time rate, pays-after-delivery flag, notes), `supplier_rate_cards`, `sourcing_requests` (brief, channels, status), `sourcing_posts` (platform, draft body, budget, status draft/approved/posted/closed, external id), `supplier_candidates` (sourcing request, supplier or external profile, quoted price, turnaround, country, score, shortlisted), `delivery_estimates` (low/expected/high, method rate_card/market_band/candidate_quote/ai_build/in_house, chosen supplier).

Money: `margin_evaluations` (every input line stored, margin amount and %, passed, reason), `proposals` (bid body, amount, currency, delivery days, milestones, status draft/queued/approved/rejected/submitted/failed, approved_by, approved_via telegram/web/auto, platform ref), `pipeline_items` (stage applied/replied/discovery/briefed/sourcing/won/in_delivery/delivered/paid/lost, retainer flag and monthly amount), `delivery_orders`, `payments` (direction in/out, amount, currency, fx rate used, paid_at, reference).

Templates and learning: `templates`, `template_variants` (sends, replies), `auto_replies`.

Platform: `events` (append-only audit log of every state change and external call), `settings` (per org: margin rules, fee table per platform, FX buffer %, live mode), `subscriptions`, `usage_counters`, `affiliates`, `attribution` (Phase 4).

Seed `service_categories` with: website-build, wordpress, elementor, shopify, landing-page, web-app, mobile-app, api-integration, automation, ai-chatbot, seo, google-ads, social-media-management, logo-brand, graphic-design, ui-ux, video-editing, copywriting, data-entry, virtual-assistant, 2d-game, 3d-game.

## E. Workers

| Worker | Trigger | Does | Writes |
|---|---|---|---|
| ingest | per scanner interval | Calls Freelancer.com project search with scanner filters; upserts; enqueues score for new jobs | jobs, events |
| score | new job | LLM scoring against strict JSON schema; rejects invalid output and retries once | job_scores |
| estimate | score verdict ≠ skip | Classifies category; estimate order: in-house capability → supplier rate card → market band p50 → AI-build tier (website categories only) | delivery_estimates |
| margin | after estimate | margin = client budget − platform fee − supplier cost − FX buffer − tool costs; compares to org rules | margin_evaluations |
| draft-bid | margin passed | Builds bid from template + job + client history + portfolio + real estimate + milestone split; queues for approval | proposals |
| submit | approval event | Places bid via API; creates pipeline item; enforces daily cap and LIVE_MODE | proposals, pipeline_items |
| inbox-sync | interval | Pulls new client messages for connected accounts; stores; alerts operator | threads, messages |
| auto-reply | inbound while operator offline | Sends the configured first reply once per thread only | messages |
| discovery | client replied | Drafts the next discovery question set for approval; updates completeness | discovery_sessions |
| brief-build | discovery ≥ threshold | Produces structured brief; operator locks it | briefs |
| sourcing | brief locked and not in-house | Ranks existing suppliers; drafts sourcing post(s) for approval; after approval posts on Freelancer.com as an employer project (LIVE_MODE only); collects candidate bids into supplier_candidates | sourcing_*, supplier_candidates |
| reprice | candidate quote received | Recomputes estimate and margin with the real quote | delivery_estimates, margin_evaluations |
| price-refresh | weekly | Updates market bands from completed-project data where the API allows; otherwise from owner CSV import | market_price_bands |
| rollup | nightly | Analytics aggregates | analytics tables/views |

All workers idempotent, retried with exponential backoff, and every external call logged to `events` with request id and outcome.

## F. Discovery and brief

Discovery question set (versioned in packages/core), asked in small batches, never all at once:
1. What is the end result you need, in one sentence?
2. Who uses it (you, your staff, your customers)?
3. What must it do on day one? What can wait?
4. Do you have examples you like (links, screenshots)?
5. Existing assets: domain, hosting, logins, brand files, content, data?
6. Technology constraints or preferences?
7. Deadline, and is it fixed?
8. Budget range, and fixed or hourly?
9. How will you judge that it is finished (acceptance)?
10. Who signs off, and how fast can they respond?

Brief schema (JSON, validated): title, one-line outcome, users, must-haves[], later[], references[], assets_provided[], assets_missing[], tech_constraints[], deadline, deadline_fixed, budget {min,max,currency,type}, acceptance_criteria[], sign_off {name, response_time}, risks[], category, delivery_route (in_house/ai_build/supplier/source_new).

## G. Margin rules

Settings per org, all required before live mode (no defaults assumed for fees — see 02-BLOCKERS):
- platform fee table per platform and project type (percentage and/or fixed minimum), entered from the platform's official fee page with the URL and date recorded;
- supplier-side platform fee when sourcing through a marketplace;
- FX buffer % (owner decision);
- minimum margin % and minimum margin amount in ZAR;
- VAT handling: all ZAR prices shown to the operator VAT-inclusive at 15% where VAT applies.

Every margin calculation stores each input line so it can be audited, and has a unit test with a hand-calculated expected value.

## H. Approval and safety

- Default: every outbound action (bid, message, discovery question, sourcing post, supplier message) requires approval.
- Optional auto-send per scanner, off by default, with a hard daily cap and minimum score.
- LIVE_MODE=false blocks every outbound API call and logs what would have been sent.
- One marketplace account per verified identity. No multi-account features.
- No fabricated portfolio items, no copied work samples, no fake reviews, no fake scarcity. Portfolio items must be flagged own_work or labelled_demo.

## I. Interfaces

Web pages (each a separate HTML file):
- login, dashboard (month-to-date revenue in and out, margin, pipeline value, replies, win rate, retainer total),
- feed (jobs with score, estimate, margin, Queue bid button),
- approvals (all pending outbound items, approve / edit / reject, bulk),
- conversations (threads, discovery progress, brief builder),
- sourcing (requests, posts, candidates, shortlist, choose supplier),
- pipeline (board by stage, retainer toggle),
- suppliers (database, rate cards, CSV import, history),
- templates (variants, reply rates),
- analytics,
- settings (platform accounts, scanners, margin rules, fee table, FX buffer, auto-reply, Telegram link, live mode switch with confirmation),
- audit log (events viewer).

Telegram bot: `/start` (link via one-time code), `/queue`, `/pause`, `/resume`, `/stats`. Each approval card shows the item, score, estimated cost, projected margin in ZAR and deal currency, and buttons Approve / Edit / Reject.

MCP server tools: search_jobs, score_job, estimate_delivery, draft_bid, approve_item, submit_bid, get_thread, build_brief, create_sourcing_post, list_suppliers, update_pipeline.

Design: dark theme, Logi-Ink cyan #00C2FF primary (confirm exact value in 02-BLOCKERS), default body typography at normal size and line spacing, responsive down to 380 px wide, UK English copy, DD/MM/YYYY dates.

## J. Environment variables (.env.example)

SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, LLM_MODEL_SCORE, LLM_MODEL_DRAFT, FREELANCER_CLIENT_ID, FREELANCER_CLIENT_SECRET, FREELANCER_REDIRECT_URI, FREELANCER_BASE_URL (sandbox or live), TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, EMAIL_PROVIDER_KEY, FX_API_URL, FX_API_KEY, APP_URL, API_URL, LIVE_MODE=false. Phase 3+: UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET. Phase 4: PAYSTACK_SECRET_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.

## K. Hosting and preview links

- Web front end: deployed to the host the owner chooses in 02-BLOCKERS (Vercel or Cloudflare Pages). Every push to main produces a preview; the production URL is recorded in README.md.
- API, workers and Telegram bot: deployed to the host the owner chooses in 02-BLOCKERS.
- If hosting credentials are not yet provided, the phase report must say NOT DONE for the preview link — never substitute localhost.

## L. Phases

- Phase 1 — Find, qualify, price, bid, approve (Freelancer.com, internal use, sandbox then live).
- Phase 2 — Conversations, discovery, brief, sourcing, supplier database, reprice.
- Phase 3 — Delivery orders, payments, retainers, analytics, Upwork (if approved), MCP.
- Phase 4 — Multi-tenant SaaS: sign-up, plans, Paystack/Stripe billing, usage limits, affiliates.

Ticket-level detail, dependencies and acceptance criteria: 04-PROJECT-BOARD.md.

## M. Definition of done (every ticket)

1. Acceptance criteria in 04-PROJECT-BOARD.md pass.
2. 05-AUDIT-PROTOCOL.md checklist passes and is pasted in the commit body.
3. Tests written and green in CI (GitHub Actions workflow runs lint, typecheck, Vitest, Playwright on every push).
4. Board updated with Status DONE and closing SHA.
5. Pushed; remote SHA verified equal to local HEAD.
