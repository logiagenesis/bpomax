# Arbitron

Freelance-marketplace arbitrage platform for Logi-Ink (Pty) Ltd.

Arbitron pulls jobs from freelance marketplaces, scores them, helps you run a structured
discovery conversation with the client, turns that into a brief, works out who can deliver
it and for how much, checks the margin, and tracks the job through to payment.

The full specification lives in [`docs/`](docs/). `docs/01-MASTER-BUILD-PROMPT.md` is the
spec; `docs/04-PROJECT-BOARD.md` is the live board and the single source of truth for what
is built and what is not.

> **Working name.** The specification in `docs/` refers to the repository
> `logiagenesis/arbitron`. This repository is `logiagenesis/bpomax` — see `DECISIONS.md`
> D-001. Where the docs say `arbitron`, read `bpomax`.

## Status

Phase 0 (repository and foundations). Nothing is deployed and no marketplace call is
live. `LIVE_MODE` defaults to `false`, which blocks every outbound marketplace call and
logs what would have been sent.

## Prerequisites

| Tool         | Version             | Notes                                                       |
| ------------ | ------------------- | ----------------------------------------------------------- |
| Node         | 20 or newer         | CI runs 20; `engines.node` is `>=20` (`DECISIONS.md` D-005) |
| pnpm         | 10 or newer         | `corepack enable` is the easiest route                      |
| Docker       | any current version | For Redis and Postgres via `docker-compose.yml`             |
| Supabase CLI | latest              | Only needed for the full local Supabase stack               |

## Setup

```bash
git clone https://github.com/logiagenesis/bpomax.git
cd bpomax
pnpm install
cp .env.example .env     # then fill it in — see docs/02-BLOCKERS.md
```

`.env.example` carries every variable the spec lists in section J, and a test
(`tests/env-example.test.ts`) fails the build if the two ever drift apart. Most values are
blank because they need an account or a key only the owner can create; `docs/02-BLOCKERS.md`
says which, and which tickets each one holds up.

## Run

```bash
docker compose up -d        # Redis on 6379, Postgres on 54322
pnpm --filter @arbitron/web dev    # front end on http://localhost:5173
```

The API, workers and Telegram bot are scaffolds until ARB-012 onwards; they have no
runnable server yet.

For the full local Supabase stack (Auth, Storage, Studio), use the Supabase CLI rather
than compose — `supabase start`. See `DECISIONS.md` D-006.

## Checks

```bash
pnpm lint           # ESLint
pnpm format:check   # Prettier
pnpm typecheck      # tsc across every workspace
pnpm test           # Vitest
pnpm test:e2e       # Playwright
```

All five run in CI on every push and pull request.

If the machine already has a Chromium that Playwright can drive, point at it instead of
downloading another:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome pnpm test:e2e
```

## Layout

```
apps/web         Vite static multi-page front end, vanilla JS ES modules
apps/api         Fastify API and MCP server
apps/workers     BullMQ workers
apps/telegram    Telegram webhook bot
packages/core    Margin maths, scoring schemas, taxonomy, brief schema
packages/db      Supabase migrations, seed data, generated types
packages/llm     Provider-agnostic LLM client and prompt templates
docs/            Specification, project board, audit protocol, blockers
brand-assets/    Owner-supplied brand images (docs/03-IMAGE-GENERATION.md)
tests/           Repository-level tests
e2e/             Playwright end-to-end tests
```

## Deploy

Not yet deployed. Hosting is ARB-070 and is held up by blockers B-11 (front-end host) and
B-12 (back-end host) in `docs/02-BLOCKERS.md`; neither account exists yet.

Per `docs/01` section K, a phase is not done without a live preview URL, and localhost is
never an acceptable substitute. The table below stays honest about that.

## Links

| Link        | URL                                            |
| ----------- | ---------------------------------------------- |
| Repository  | https://github.com/logiagenesis/bpomax         |
| CI          | https://github.com/logiagenesis/bpomax/actions |
| Phase 1 tag | NOT DONE — Phase 1 has not started             |
| Web preview | NOT DONE — blocked on B-11                     |
| API health  | NOT DONE — blocked on B-12                     |

## Safety

The rules in `docs/01` section H are not optional:

- Every outbound action — bid, message, discovery question, sourcing post — needs approval.
- `LIVE_MODE=false` blocks every outbound marketplace call and logs what would have been sent.
- One marketplace account per verified identity. No multi-account features.
- No fabricated portfolio items, no copied work samples, no fake reviews, no fake scarcity.

## Documentation

| File                             | What it is                                          |
| -------------------------------- | --------------------------------------------------- |
| `docs/00-README.md`              | Index of the build package                          |
| `docs/01-MASTER-BUILD-PROMPT.md` | The specification                                   |
| `docs/02-BLOCKERS.md`            | Owner action list: accounts, keys, decisions        |
| `docs/03-IMAGE-GENERATION.md`    | Brand assets the owner supplies                     |
| `docs/04-PROJECT-BOARD.md`       | Live board — status and closing SHA per ticket      |
| `docs/05-AUDIT-PROTOCOL.md`      | The checklist every ticket passes before it is done |
| `docs/BLOCKERS.md`               | Blockers found while building                       |
| `DECISIONS.md`                   | Every choice the docs left open, with the reason    |
