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

Phase 0 is complete. Phase 1 is in progress: the data model, its tenancy, the role
split, the audit log, the retention job, the scoring, estimating, margin, drafting and
submit workers, the Telegram bot and the web pages (login, dashboard, feed, approvals,
settings, audit log) are built and tested. The web app is deployed to Vercel in demo mode
(<https://bpomax.vercel.app>); the API, workers and bot are not deployed, and no marketplace
call is live. `LIVE_MODE` defaults to `false`, which blocks every outbound marketplace call and
logs what would have been sent.

`docs/04-PROJECT-BOARD.md` is the live board — status and closing SHA per ticket, and
the reason for every one that is blocked.

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
pnpm compose:up             # Redis on 6379, Postgres on 54322; waits until both are healthy
pnpm db:reset               # recreate the compose Postgres, apply every migration, then the seed
pnpm db:migrate             # apply packages/db/migrations to DATABASE_URL
pnpm db:seed                # service categories (and any owner-supplied price bands); safe to repeat
pnpm db:types               # regenerate packages/db/src/types.generated.ts from the migrations
pnpm --filter @arbitron/web dev    # front end on http://localhost:5173
```

The API is built and tested but has no listen entry point yet: hosting is ARB-070. It
is importable today — `buildServer({ db, authenticate, enqueue, liveMode })` in
`apps/api/src/server.ts` serves `/health`, the audit log, scanners, the Telegram link
code and, from ARB-061, `/v1/me`, `/v1/dashboard`, `/v1/jobs` (with `queue-bid`),
`/v1/proposals` (approve, edit, reject, bulk) and `/v1/settings` (rules, fee table, live
mode, platform-account plan). `supabaseAuthenticator({ url, anonKey })` in
`apps/api/src/auth.ts` is the production `authenticate`: it verifies a browser's bearer
token with the Supabase project (B-06). The workers have their queue wiring — one BullMQ
queue per worker in docs/01 section E, exponential-backoff retries, a dead-letter queue
and a `/health` server (`apps/workers/src/`) — and the score, estimate, margin,
draft-bid and submit processors; no real model has been called (B-08) and no
marketplace client exists (C-02). The Telegram bot (ARB-050) handles link codes, the
four commands and approval cards.

The web pages (ARB-061) are `login.html`, `dashboard.html`, `feed.html`,
`approvals.html`, `settings.html` and `audit-log.html`, with the design system at
`style-guide.html`. The login page signs in against the Supabase project directly and
every other page calls the API with the session's bearer token; the build reads
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `API_URL` from `.env` (or the host's
environment) at build time. Without them the login page says so and nothing else can
be reached. Every control on every page is listed in `docs/audit/<page>.md` with the
Playwright test that exercises it (docs/05 section 1); the end-to-end build
(`pnpm build:web:e2e`) reads `/.env.e2e`, stand-in URLs the specs intercept.

For the full local Supabase stack (Auth, Storage, Studio), use the Supabase CLI rather
than compose — `supabase start`. See `DECISIONS.md` D-006.

## MCP server

`apps/mcp` (ARB-330) lets Claude Desktop or Claude Code work the pipeline through eleven
tools: `search_jobs`, `score_job`, `estimate_delivery`, `draft_bid`, `approve_item`,
`submit_bid`, `get_thread`, `build_brief`, `create_sourcing_post`, `list_suppliers` and
`update_pipeline`. It speaks MCP over stdio and each tool is one call to the API with your
own sign-in token, so the API decides exactly as it does on the web: your role, your
organisation's rows only, the approval rules and the live gate. An approval made through
it is recorded in your name with the channel `mcp`. Nothing is sent to a marketplace by the
MCP server itself; an approved bid still goes through the submit worker and `LIVE_MODE`.

It needs three settings, and refuses to start without them. The channel key is a long
random string the owner generates (for example `openssl rand -hex 32`) and sets as
`MCP_CHANNEL_KEY` where the API runs; with it the API records an approval as made through
MCP, and without it no request can claim to be (D-074). It is not in `.env.example`, which
holds exactly docs/01 section J's variables.

| Setting                    | What it is                                                                    |
| -------------------------- | ----------------------------------------------------------------------------- |
| `ARBITRON_API_URL`         | The API's address (https; http only for localhost)                            |
| `ARBITRON_ACCESS_TOKEN`    | Your Supabase access token from signing in (docs/02 B-06); it is never logged |
| `ARBITRON_MCP_CHANNEL_KEY` | The API's `MCP_CHANNEL_KEY`, from the owner; it is never logged               |

The API has no hosted address yet (ARB-070), so until it has one the server is exercised by
its test (`apps/mcp/src/server.test.ts`), which calls every tool against the real API and
Postgres. A sign-in token expires; a tool that answers "not signed in" needs a fresh one
(D-062).

**Claude Code** — `claude mcp add` with `--env` for each setting and a transport between
the settings and the name, as the Claude Code docs describe
(<https://code.claude.com/docs/en/mcp>):

```bash
claude mcp add --env ARBITRON_API_URL=https://api.example.test \
  --env ARBITRON_ACCESS_TOKEN=<your token> \
  --env ARBITRON_MCP_CHANNEL_KEY=<the channel key> \
  --transport stdio arbitron -- /path/to/bpomax/node_modules/.bin/tsx /path/to/bpomax/apps/mcp/src/main.ts
```

**Claude Desktop** — add an entry under `mcpServers` in `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows), with `command`, `args` and
`env` as the MCP documentation shows
(<https://modelcontextprotocol.io/docs/develop/connect-local-servers>), then restart
Claude Desktop:

```json
{
  "mcpServers": {
    "arbitron": {
      "command": "/path/to/bpomax/node_modules/.bin/tsx",
      "args": ["/path/to/bpomax/apps/mcp/src/main.ts"],
      "env": {
        "ARBITRON_API_URL": "https://api.example.test",
        "ARBITRON_ACCESS_TOKEN": "<your token>",
        "ARBITRON_MCP_CHANNEL_KEY": "<the channel key>"
      }
    }
  }
}
```

Replace `/path/to/bpomax` with where this repository is checked out, after `pnpm install`.

## Checks

```bash
pnpm lint           # ESLint
pnpm format:check   # Prettier
pnpm typecheck      # tsc across every workspace
pnpm test           # Vitest (the queue tests need Redis: `docker compose up -d redis`)
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
apps/api         Fastify API
apps/mcp         MCP server: the operator's tools over the API (ARB-330)
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

The web app deploys to Vercel from `main` on every push (project `bpomax`, ARB-070):
<https://bpomax.vercel.app>. Each deployment also gets its own address, listed in the
Vercel project.

- **Build.** `vercel.json` runs `scripts/build-web-vercel.sh`. With `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` and `API_URL` set in the Vercel project's environment, it builds the
  real app. With any of them missing, it builds **demo mode** (DECISIONS.md D-043). Every
  page is then viewable with sample data answered inside the browser, and a banner on
  every page says so. Nothing is saved or sent. To switch to the real app, add the three
  variables in Vercel and redeploy.
- **Branches.** Pushes to `claude/*` branches are not deployed. They are proven by CI and
  reach Vercel only once merged into `main` (D-042).
- **Back end.** The API, workers and Telegram bot are not deployed yet. They need a host
  for long-running Node processes (docs/02 B-12).

Per `docs/01` section K, a phase is not done without a live preview URL, and localhost is
never an acceptable substitute.

## Links

| Link        | URL                                            |
| ----------- | ---------------------------------------------- |
| Repository  | https://github.com/logiagenesis/bpomax         |
| CI          | https://github.com/logiagenesis/bpomax/actions |
| Phase 1 tag | NOT DONE — Phase 1 is not complete             |
| Web app     | https://bpomax.vercel.app (demo mode, D-043)   |
| API health  | NOT DONE — blocked on B-12                     |

## How tenancy works

Every table has row level security. A signed-in user reaches a row only through a
membership of that row's org, and `anon` is granted nothing at all. Application code
never passes an `org_id` to scope a read: `withUser(db, authUserId, work)` sets the JWT
claims and the `authenticated` role for the length of one transaction, and the database
decides. A handler that forgets a filter therefore returns less than it meant to, never
more than it should.

Roles are `owner`, `operator` and `viewer`. Operators write records and approve outbound
actions; only owners change settings, membership and billing; viewers write nothing. The
rule is stated once in `packages/core/src/auth.ts` for the interface and enforced by the
policies, and `packages/db/src/role-parity.test.ts` fails if the two ever disagree.

## Safety

The rules in `docs/01` section H are not optional:

- Every outbound action — bid, message, discovery question, sourcing post — needs approval.
- `LIVE_MODE=false` blocks every outbound marketplace call and logs what would have been sent.
- One marketplace account per verified identity. No multi-account features.
- No fabricated portfolio items, no copied work samples, no fake reviews, no fake scarcity.

Several of these are enforced by the database rather than by application code, so they
hold regardless of which worker or console session is writing: an outbound message
cannot be marked sent without an approval, a scanner cannot auto-send without a daily cap
and a score floor, a thread can have at most one auto-reply ever, an approval can only
name the person who made it, and `live_mode` cannot be switched on while a margin rule
or the retention period is missing.

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
| `packages/db/seed/README.md`     | What is seeded, and why the price bands are empty   |
| `DECISIONS.md`                   | Every choice the docs left open, with the reason    |
