# ARBITRON — Build Package

Document: LI-PACK-ARB-0926 v1.0 — 22/09/2026
Owner: Logi-Ink (Pty) Ltd

This folder is the single source of truth for building ARBITRON (working name): software that pulls relevant jobs from freelance marketplaces, qualifies them, helps you contact the client and find out exactly what they want, turns that into a brief, finds who in the world can deliver it (in-house, AI-assisted, or a supplier), checks the margin, and tracks the job to payment.

## Files

| File | Purpose | Who acts |
|---|---|---|
| 00-README.md | This index and the order of work | Owner |
| 01-MASTER-BUILD-PROMPT.md | The prompt to paste into Claude Code, plus the full spec it builds from. Creates the GitHub repo and pushes every ticket | Claude Code |
| 02-BLOCKERS.md | Every account, key, rule and decision needed. Nothing is assumed | Owner |
| 03-IMAGE-GENERATION.md | Logo, icons and images with exact prompts, sizes and file names | Owner |
| 04-PROJECT-BOARD.md | Every ticket by phase, with dependencies, blockers and acceptance criteria. Claude Code keeps it live | Claude Code / Owner |
| 05-AUDIT-PROTOCOL.md | Button, copy, numbers, security, facts and delivery audits. Triple-check rule | Claude Code / Owner |
| reference/R1-competitor-audit.md | Research: 10 marketplace bidding tools | Background |
| reference/R2-funnel-and-software-intel.md | Research: BPO Accelerator software and funnel | Background |
| reference/R3-early-build-brief.md | Early brief, superseded by 01 | Background |

## Order of work

1. Owner: clear every HARD item in 02-BLOCKERS.md that blocks "Start", Phase 0 and Phase 1.
2. Owner: generate the images in 03 (optional before Phase 1).
3. Owner: create an empty folder, copy this whole package into it as `/docs`, open Claude Code there.
4. Owner: paste the code block from 01-MASTER-BUILD-PROMPT.md.
5. Claude Code: creates `logiagenesis/arbitron`, pushes, and works the board ticket by ticket, pushing after each one.
6. At the end of each phase Claude Code prints four links: repository, latest commit, phase tag, live preview. No four links means the phase is not done.
7. Owner: opens the links, spot-checks per 05 section 7, signs off.

## What is not yet verified (read before starting)

- Freelancer.com: public project search works without a token; bidding, messaging and posting need OAuth2; an official SDK and a sandbox exist. Fees, bid allowances and whether its terms permit API-driven bidding must be confirmed from official pages (02-BLOCKERS T-01 to T-03).
- Upwork: requires API approval; timeline unknown (B-14).
- Fiverr: no verified buyer API; manual CSV only.
- Pricing of the SaaS, margin thresholds and FX buffer are owner decisions; no defaults are assumed.
