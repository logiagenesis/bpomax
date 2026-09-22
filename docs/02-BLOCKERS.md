# 02 — BLOCKERS (owner action list)

Document: LI-BLK-ARB-0926 v1.0 — 22/09/2026

Nothing here is assumed. Each item is something only the owner can provide or decide. HARD items stop the build at the step shown. SOFT items can be filled later without rework.

Mark each item done by writing the answer or "DONE dd/mm/yyyy" in the Answer column. Never paste secrets into this file — put secrets only into the `.env` file on your machine and into the hosting provider's secret store.

## 1. Accounts and access

| # | Item | Type | Blocks | What to do | Answer |
|---|---|---|---|---|---|
| B-01 | GitHub organisation/account `logiagenesis` accessible from the machine running Claude Code | HARD | Start | Install GitHub CLI (https://cli.github.com), run `gh auth login`, confirm `gh auth status` shows logiagenesis access | |
| B-02 | Claude Code installed and signed in | HARD | Start | Install per https://docs.claude.com/en/docs/claude-code/overview | |
| B-03 | Freelancer.com developer app (client ID, client secret, redirect URI) | HARD | ARB-020 | Register at https://developers.freelancer.com. Record the scopes granted. Create both a sandbox app and a live app if the portal separates them | |
| B-04 | Freelancer.com sandbox test accounts (one freelancer, one employer) | HARD | ARB-020 onward | Create at https://www.freelancer-sandbox.com | |
| B-05 | Which live Freelancer.com account will be connected (Logi-Ink company account or personal) and confirmation it is ID-verified | HARD | Live mode | Decide and verify in account settings | |
| B-06 | Supabase project (URL, anon key, service role key, DB URL) | HARD | ARB-010 | Create at https://supabase.com. Region choice to be decided (see D-05) | |
| B-07 | Redis instance URL (hosted or local Docker) | HARD | ARB-030 | Upstash, Redis Cloud, or local docker-compose | |
| B-08 | Anthropic API key with billing enabled | HARD | ARB-031 | https://console.anthropic.com | |
| B-09 | Telegram bot token | HARD | ARB-050 | Create via @BotFather in Telegram; send the token to your `.env` only | |
| B-10 | FX rates provider and key | HARD | ARB-040 | Choose one (e.g. an FX API you trust); record URL and plan limits | |
| B-11 | Front-end hosting account (Vercel or Cloudflare Pages) linked to GitHub | HARD | Phase preview links | Connect the repo after it is created | |
| B-12 | Back-end hosting account for API, workers, bot (e.g. Render, Fly.io, a VPS) | HARD | Phase 1 tag | Choose and create | |
| B-13 | Email sending provider (for alerts and later billing emails) | SOFT | ARB-410 | Choose provider, verify sending domain | |
| B-14 | Upwork API key application | HARD for Phase 3 | ARB-300 | Apply via Upwork developer portal now; approval time is outside our control | |
| B-15 | Paystack and Stripe accounts | HARD for Phase 4 | ARB-400 | Business verification in Logi-Ink name | |

## 2. Rules and terms that must be read and confirmed by the owner

| # | Item | Type | Blocks | What to do | Answer |
|---|---|---|---|---|---|
| T-01 | Freelancer.com Terms and Conditions and API terms — confirm automated bid submission via official API with human approval is permitted, and any rate limits or bid quotas | HARD | Live mode | Read official terms; paste the relevant clause URLs here | |
| T-02 | Freelancer.com fee schedule for freelancers (project fees) and for employers (when we post sourcing projects) | HARD | ARB-041 | Take figures only from Freelancer's official fees page; record URL and date | |
| T-03 | Freelancer.com membership plan and bid allowance on the account used | HARD | ARB-042 | Record plan name and monthly bid limit | |
| T-04 | Upwork API terms and agency/Business Manager rules | HARD for Phase 3 | ARB-300 | Read and record | |
| T-05 | Legal structure for paying overseas suppliers (Exchange Control/SARB reporting, invoicing, VAT treatment of export services) | HARD before first live supplier payment | ARB-310 | Confirm with Logi-Ink's accountant | |
| T-06 | POPIA and client data handling (storing client messages and briefs) | HARD before live mode | ARB-015 | Confirm retention period and privacy notice with legal adviser | |

## 3. Business decisions

| # | Decision | Type | Blocks | Options / notes | Answer |
|---|---|---|---|---|---|
| D-01 | Product name and domain | SOFT (Phase 1 uses "Arbitron" working name) | ARB-400 branding | Name drives logo prompts in 03-IMAGE-GENERATION | |
| D-02 | Minimum margin % and minimum margin amount (ZAR) | HARD | ARB-041 | No default will be assumed | |
| D-03 | FX buffer % | HARD | ARB-041 | No default will be assumed | |
| D-04 | Service categories Logi-Ink delivers in-house (never sourced out) | HARD | ARB-040 | Tick from the category list in 01 section D | |
| D-05 | Data region for Supabase and hosting | HARD | ARB-010 | Consider POPIA advice from T-06 | |
| D-06 | Starting saved searches (keywords, categories, budget floor, client countries to include/exclude) | HARD | ARB-021 | Provide at least 3 | |
| D-07 | Bid templates: tone, CTA style, sign-off, company name shown to clients | HARD | ARB-043 | Provide one approved template per main category or approve the drafts Claude Code produces | |
| D-08 | Auto-reply text for first client message | SOFT | ARB-121 | Provide or approve draft | |
| D-09 | Initial supplier list (name, country, channel, categories, rates, turnaround, pays-after-delivery yes/no) | HARD for Phase 2 | ARB-200 | CSV template will be generated at ARB-200 | |
| D-10 | Portfolio items that are genuinely Logi-Ink work (URLs, screenshots, permission to show) | HARD | ARB-043 | Only own work or clearly labelled demos | |
| D-11 | Confirm exact Logi-Ink brand colour values (primary cyan hex, secondary) and supply the logo file | SOFT | ARB-060 | Needed for design tokens | |
| D-12 | SaaS pricing (Phase 4) | HARD for Phase 4 | ARB-410 | Earlier working figures are not approved | |
| D-13 | Who besides the owner gets operator access in Phase 1 | SOFT | ARB-012 | Names and roles | |

## Raised during build

Claude Code appends new blockers here with: ID (B-1xx), date, ticket blocked, exact information needed, from whom.

| # | Date | Ticket | Needed | From | Answer |
|---|---|---|---|---|---|
