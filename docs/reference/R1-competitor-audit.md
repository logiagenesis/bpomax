# Marketplace Arbitrage Software — Competitor Audit

Date: 22/09/2026
Scope: software that watches freelance marketplaces, surfaces actionable jobs, drafts or submits proposals, and (ideally) routes delivery to cheaper suppliers. CRMs and generic lead-gen tools excluded.

Verification note: prices and features below come from vendor sites or competitor comparison pages (sources at the end). Competitor-written comparisons are biased; where a figure comes only from a rival, it is marked "reported".

---

## 1. The market in one table

| # | Tool | Marketplace | Model | Price (USD) | Where automation runs |
|---|------|-------------|-------|-------------|----------------------|
| 1 | GigRadar | Upwork | Agency, managed auto-bidding, ML-filtered feeds, CRM | No public pricing; reported ~$200–$470+/mo | Upwork Business Manager (reported) |
| 2 | Vollna | Upwork | Job feed, AI qualifier, AI cover letters, auto-bidding, market insights | Freelancer $16/mo, Agency $41/mo, Auto-bidding from $149/mo | Verified Business Manager joins your agency |
| 3 | Upwex | Upwork | Chrome extension: 0–100 job score, cover letters, Q&A autofill, auto-bid on top tier | From ~$4.99/mo; auto-bid on Max (~$49/mo, reported) | Inside your own logged-in browser session |
| 4 | UpHunt | Upwork | AI feeds, 1–10 job scoring, managed auto-apply | $27/mo feeds; $89/mo Auto-Apply (50 proposals) | Dedicated BD account in your Agency Plus |
| 5 | GetMany | Upwork | Premium agency auto-bidding, AI scoring, MCP server | From $349/mo (reported) | Not disclosed on site (reported) |
| 6 | BidPilotPro | Upwork + Freelancer.com | Human-in-the-loop AI proposals, semantic matching to past work | Freemium, 5 free credits | Chrome extension, user submits |
| 7 | FreelancerAutoBid | Freelancer.com | Auto-bid, filters, active hours, bid limits, analytics, CSV export | Free trial | Extension / session |
| 8 | Bidswala | Freelancer.com | Scheduled auto-bid, daily caps, currency/country filters, per-type rates | Not verified | Not verified |
| 9 | FreeBID / Autobidbot / BidMasterPro | Freelancer.com (+Upwork) | ChatGPT bid bots, keyword/budget/country filters | Trials; not verified | Extension or server bot |
| 10 | n8n "Freelancer Auto-Bid Bot" template | Freelancer.com | DIY: API search, dedupe, AI proposal, Telegram approve-then-bid | Free template (n8n hosting costs) | Official Freelancer API, human approval |

Native threat: Upwork's own Uma AI now drafts proposals inside Upwork. Any "we write your cover letter" feature alone is being commoditised by the platform itself.

---

## 2. What every serious tool does (table stakes)

- Near-real-time job ingestion (seconds to ~10 minutes after posting).
- Deep filters: 30–40+ fields — budget, category, skills, client country, payment verified, hire rate, total spend, proposal count, experience level.
- AI job qualification: a fit score (0–100 or 1–10) with GO / CAUTION / SKIP and red-flag detection (vague brief, low spender, ghost client, scam text).
- AI proposal generation from job + client history + your profile; templates, attachments, screening-question answers.
- Guardrails: daily bid caps, active hours, min score, spend limits, connect/credit top-ups.
- Analytics: reply rate per template, per filter/"scanner", per category; A/B testing of cover letters and rates.
- Notifications: email, Telegram, Slack.

## 3. What the leaders do that is worth stealing

- Speed economics (GigRadar/Vollna): bidding within ~5–10 minutes of posting is the single biggest lever; boost spend only pays in specific bands and when you are late.
- Cost-per-reply by category (GigRadar): replies in saturated categories (web/dev) cost far more than writing; fixed-price bids cost less per reply than hourly. Track this per filter.
- Market insights (Vollna): live demand, rate ranges, connect costs and benchmarked reply rates per niche. This is how you choose what to sell.
- Client-quality inversion (GigRadar data): very large-spend clients reply less than small ones. Score for reply likelihood, not just budget.
- Compliant submission model (Vollna/UpHunt): proposals go through a verified Business Manager inside the user's Upwork agency — no password sharing, no browser scraping.
- Approve-in-Telegram flow (n8n template): one-tap Bid / Skip from a phone. Cheap, fast, human-in-the-loop, ToS-friendly.
- MCP/API layer (GetMany): lets agents like Claude drive search, drafting and scheduling. Worth building from day one.

## 4. The gap nobody fills (your product)

Every tool above stops at "win the job". None of them answer the second half of the arbitrage model:

1. Where do I get this delivered, and for how much?
2. What is my margin after platform fees, supplier cost and FX?
3. Is this job worth bidding given what delivery will cost?

No audited tool recommends a supplier, estimates delivery cost, or computes margin before you bid. Arbitrage operators currently do this by hand (win on Upwork/Freelancer.com, then hunt on Fiverr or similar). That is the differentiator.

## 5. Data access — what is actually possible

| Source | Access route | Status |
|--------|-------------|--------|
| Upwork jobs | RSS | Dead since 20/08/2024 |
| Upwork jobs | Official GraphQL API (OAuth2) | Exists; approval required and ToS-bound |
| Upwork jobs | Third-party scraped feeds (e.g. Apify actors) | Available, from ~$2.50 per 1,000 results; ToS risk sits with you |
| Upwork submission | Business Manager inside user's agency | The compliant route used by Vollna/UpHunt |
| Upwork submission | Browser extension in user's session | Works; highest ban risk |
| Freelancer.com | Official public API (search + bid) | Used by the n8n template; cleanest start |
| Fiverr (supply side) | Buyer-side API | Not verified — assume manual/scraped research until confirmed |

## 6. What we pull in — recommended build

Core loop: Ingest → Qualify → Price delivery → Draft → Approve → Submit → Track margin.

1. Ingest: Freelancer.com official API first (lowest risk), Upwork via official API once approved or a paid feed as interim.
2. Qualify: LLM fit score + red flags + client-quality + competition density + "reply likelihood".
3. Delivery pricing (the moat): map each job to a service category, pull comparable supplier price bands (Fiverr/marketplace research + your own vetted supplier list), output estimated delivery cost and a recommended supplier tier.
4. Margin gate: bid only when (client budget − platform fee − supplier cost − FX buffer) clears your target margin. Show ZAR and USD.
5. Draft: AI proposal from job + client history + profile + portfolio; screening answers.
6. Approve: Telegram/WhatsApp one-tap Bid / Edit / Skip; web queue for bulk review.
7. Submit: Freelancer.com API; Upwork via Business Manager model only.
8. Track: reply rate, win rate, cost per reply, and realised margin per filter, per category, per supplier.
9. Expose it all via an API/MCP server so an agent can operate it.

Stack (per your default): static HTML/CSS/vanilla JS + Vite front end, Supabase (auth, Postgres, row-level security), a Node worker for ingestion/scoring/submission, Paystack or Stripe for billing, Telegram Bot API for approvals.

Pricing anchors from the market: solo tools $16–$49/mo; managed auto-bidding $89–$470+/mo. A margin-aware tool can price in the $49–$149 band and justify it on "profit per job", not "proposals per month".

## 7. Risks to design around

- Platform ToS: fully silent auto-submission from a user's own session is the fastest route to bans. Human approval or Business Manager submission only.
- Upwork-only dependency: Upwork removed RSS explicitly to curb bot bidding; assume further tightening. Multi-marketplace from day one.
- Commoditisation: Upwork Uma already writes proposals. Proposal writing is not the product; delivery pricing and margin intelligence are.
- Supplier data: no verified clean API for Fiverr supply pricing; plan for your own supplier database built from real orders.

---

## Sources

- GigRadar — https://gigradar.io/
- GigRadar bidding strategy data — https://gigradar.io/blog/upwork-bidding-strategy
- GigRadar on RSS removal — https://gigradar.io/blog/upwork-rss-feed
- Vollna pricing — https://www.vollna.com/pricing
- Vollna auto-bidding — https://www.vollna.com/auto-bidding
- Vollna home — https://www.vollna.com/
- Upwex — https://upwex.io/
- Upwex job analyzer — https://upwex.io/features/upwork-job-analyzer/
- UpHunt comparisons (competitor-written) — https://uphunt.io/blog/vollna-alternatives and https://uphunt.io/blog/upwex-alternatives
- GetMany vs Vollna (competitor-written) — https://getmany.com/compare/getmany-vs-vollna
- BidPilotPro — https://www.bidpilotpro.com/blogs/freelancer-ai-auto-bidder
- FreelancerAutoBid — https://www.freelancerautobid.com/
- Bidswala — https://bidswala.com/
- FreeBID (Chrome Web Store) — https://chromewebstore.google.com/detail/freebid/njfcphkbenonfofjpcgofligdobdchgl
- Autobidbot — https://www.autobidbot.com/
- BidMasterPro — https://bidmasterpro.com/
- n8n Freelancer auto-bid template — https://n8n.io/workflows/6048-freelancer-auto-bid-bot-ai-proposals-with-telegram-approval/
- Upwork RSS deprecation — https://support.upwork.com/hc/en-us/articles/52052528243731-RSS-deprecation
- Upwork vs Fiverr (Uma AI) — https://www.upwork.com/resources/upwork-vs-fiverr
- Apify Upwork scraper pricing — https://apify.com/devcake/upwork-jobs-scraper/api
- Upwork GraphQL API example repo — https://github.com/ihoka/upwork-search
