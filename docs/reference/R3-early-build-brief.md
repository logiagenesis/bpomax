# Build Brief — Full-Loop BPO Arbitrage Platform (working name: "Arbitron")

Date: 22/09/2026
Owner: Logi-Ink (Pty) Ltd
Status: Draft v1 — architecture and phased plan

---

## 1. Verdict

BPO Accelerator sells the loop but only ships the first third of it (Freelancer.com auto-reply behind a paywall). The ten Upwork/Freelancer bidding tools ship the first two thirds (feed → qualify → draft → submit) and none of them ship the last third (price the delivery, gate on margin, route to a supplier, track realised profit).

We build all three thirds in one product. The delivery/margin engine is the moat; bidding is table stakes.

## 2. What we take from whom

| From | Take | Leave |
|------|------|-------|
| BPO Accelerator | Subscription-gated web app; Freelancer.com connect + saved-script auto-reply; affiliate + device-ID attribution cookies; TikTok source tagging; Discord as community layer; blueprint-style onboarding | Fake scarcity counter, evergreen countdown, manual leaderboard entries |
| Vollna | 30+ field filters; AI job qualifier credits; prompt-controlled cover letters with model choice; A/B testing of letters and rates; market insights per niche; Business Manager submission for Upwork; 80%/100% limit alerts | Upwork-only scope |
| GigRadar | Speed-first bidding (sub-10 min); cost-per-reply by category; boost-band logic; client-quality scoring (reply likelihood over budget size) | Opaque pricing, demo-gated sales |
| Upwex | 0–100 fit score with GO/CAUTION/SKIP; red-flag detection (vague brief, low spender, ghost, scam text); one-click screening-question autofill | Automation inside the user's own browser session |
| UpHunt | Simple per-proposal pricing ($89/50); managed BD account model | — |
| GetMany | MCP server so an agent can drive the platform | Price point |
| n8n Freelancer template | Official Freelancer API search + bid; dedupe by project ID; Telegram Bid/Cancel inline buttons | Hosted-n8n dependency |
| BidPilotPro | Semantic (embedding) match of job → your past work / portfolio | — |
| FreelancerAutoBid / Bidswala | Active hours, daily bid caps, currency + country filters, per-type rate presets, CSV export | — |

## 3. Product — the seven modules

### 3.1 Ingest
- Freelancer.com official API (projects search, project detail, bids). Poll every 60–120 s per saved search.
- Upwork: official GraphQL API once approved; interim paid feed (e.g. Apify actor, ~$2.50/1,000 jobs). Never scrape the user's session.
- Dedupe on platform + job ID. Store raw job JSON.
- Watchlists ("scanners"): keywords, category, budget floor/ceiling, hourly vs fixed, client country, payment verified, min client spend, max proposal count, posted-within minutes.

### 3.2 Qualify
- LLM scoring 0–100 → GO / CAUTION / SKIP.
- Inputs: job text, client history (hire rate, spend, reviews), competition density (bids so far), time since posting, our win history on similar jobs (embedding match to past wins/losses).
- Red flags: vague brief, off-platform payment hints, suspiciously low budget, scam phrasing, location-restricted.
- Output stored as structured JSON (score, reasons, flags, predicted reply probability).

### 3.3 Price the delivery (the moat)
- Map job → service category taxonomy (e.g. WordPress build, logo, SEO audit, data entry, video edit, copywriting).
- Supplier database: our vetted suppliers with rate cards, turnaround, quality score, capacity, currency. Seeded manually, then updated from real orders.
- Market price bands per category from research (Fiverr/marketplace snapshots; refreshed weekly by a worker). Stored as min/median/max in USD.
- Output: estimated delivery cost (low/expected/high), recommended supplier tier, turnaround estimate.

### 3.4 Margin gate
- Formula (in USD, shown in ZAR too):
  `margin = client_budget − platform_fee − supplier_cost − fx_buffer − tool_costs (connects/boost)`
- Rules per user: min margin %, min margin absolute, max delivery risk.
- Only jobs clearing the gate reach the draft queue. Everything else is logged with the reason (feeds the analytics).

### 3.5 Draft
- Proposal generated from: job, client history, our profile, matched portfolio items, chosen template, tone rules, and the delivery estimate (so the timeline and price quoted are real).
- Screening-question answers.
- Bid amount and delivery days proposed from the margin gate output.
- Template library with per-template reply-rate tracking; A/B variants.

### 3.6 Approve and submit
- Approval channel: Telegram bot (inline buttons Bid / Edit / Skip), plus a web queue for bulk review. WhatsApp later.
- Submit via Freelancer.com API (bid + message). Upwork via Business Manager model only.
- Pacing: daily caps, active hours, cooldowns, connect/credit balance checks, "continue over limit" toggle.
- Full audit log per submission.

### 3.7 Track and route
- Pipeline: Bid → Replied → Negotiating → Won → In delivery → Delivered → Paid.
- On Won: create delivery order, assign supplier, milestone dates, supplier payment record, client payment record.
- Realised margin per job, per category, per supplier, per template, per scanner.
- Analytics: reply rate, win rate, cost per reply, margin per hour of our time, supplier on-time/quality score.
- Notifications at 80%/100% of plan limits.

## 4. Data model (Supabase / Postgres, RLS on every table)

- `orgs`, `users`, `memberships` (multi-seat for agencies)
- `platform_accounts` (platform, tokens encrypted, status)
- `scanners` (filters JSON, schedule, active)
- `jobs` (platform, external_id, raw JSON, normalised fields, first_seen_at)
- `job_scores` (job_id, score, verdict, reasons, flags, reply_prob, model, cost)
- `service_categories`, `market_price_bands` (category, min/median/max, sampled_at)
- `suppliers`, `supplier_rate_cards`, `supplier_reviews`
- `delivery_estimates` (job_id, low/expected/high, supplier_id, turnaround)
- `margin_evaluations` (job_id, inputs, margin_abs, margin_pct, passed, reason)
- `templates`, `template_variants`
- `proposals` (job_id, template_variant_id, body, bid_amount, days, status, approved_by, submitted_at, platform_ref)
- `pipeline_items`, `delivery_orders`, `payments` (client + supplier)
- `events` (append-only audit log)
- `subscriptions`, `usage_counters`, `affiliates`, `attribution`

## 5. Services

- Web app: static HTML/CSS/vanilla JS + Vite. Pages: dashboard, feed, queue, pipeline, suppliers, analytics, settings, billing.
- API: Node (Fastify) on a small VPS or Fly/Render; Supabase for auth + DB + storage.
- Workers (Node, BullMQ + Redis): `ingest`, `score`, `estimate`, `draft`, `submit`, `price-refresh`, `analytics-rollup`.
- LLM layer: provider-agnostic (Anthropic / OpenAI / local), per-user model choice, token metering into `usage_counters`.
- Telegram bot service (webhook).
- MCP server exposing: search_jobs, score_job, estimate_delivery, draft_proposal, approve, submit, pipeline_update. Lets Claude Code / Claude Desktop operate the platform.
- Billing: Paystack (ZAR, local) + Stripe (USD). Plans metered on proposals/month and AI credits, same as market convention.

## 6. Compliance posture (non-negotiable)

- No password sharing, no automation inside the user's own browser session.
- Human approval on every send by default; "auto-send above score X" is an opt-in per scanner with hard daily caps.
- Upwork submission only through the Business Manager / agency-member model.
- Clear ToS in-product; per-platform terms surfaced at connect time.

## 7. Phased plan

| Phase | Weeks | Scope | Exit criterion |
|-------|-------|-------|----------------|
| 0 | 1 | Supplier taxonomy + rate cards seeded from Logi-Ink's real suppliers; market price bands v1 | 20 categories priced |
| 1 | 2–4 | Freelancer.com ingest → score → margin gate → draft → Telegram approve → submit; basic pipeline | First won job with margin tracked end to end, used internally by Logi-Ink |
| 2 | 5–7 | Web app UI, templates + A/B, analytics v1, billing, subscription gate, affiliate/attribution | 10 paying beta users |
| 3 | 8–10 | Upwork via official API + Business Manager submission; supplier scoring from real orders; MCP server | Two-marketplace operation |
| 4 | 11+ | Delivery order management, supplier payments, WhatsApp approvals, agency seats, market-insights page | Public launch |

## 8. Pricing (working)

| Plan | ZAR/mo (VAT incl.) | Includes |
|------|-------------------|----------|
| Solo | R899 | 1 platform account, 50 approved proposals, 500 AI credits, margin engine, Telegram approvals |
| Operator | R1,999 | 2 platforms, 200 proposals, 2,500 credits, A/B, supplier scoring, analytics |
| Agency | R4,499 | 5 seats, 600 proposals, MCP API, delivery orders, priority feed |
| Overage | per proposal / per 1,000 credits | — |

Competitor anchors: solo tools $16–$49/mo; managed auto-bidding $89–$470+/mo. We sit between, and sell on profit per job rather than proposals per month.

## 9. Open items to settle before Phase 1

1. Freelancer.com API app registration and rate limits (verify current terms).
2. Upwork API application timeline (start now; it gates Phase 3).
3. Which LLM provider is primary (cost per score + draft at volume).
4. Supplier list: who from Logi-Ink's existing network goes in first.
5. Product name and domain.
