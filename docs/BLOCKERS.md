# BLOCKERS — raised during the build

Document: LI-BLKBUILD-ARB-0926 — opened 22/09/2026
Companion to docs/02-BLOCKERS.md, which is the owner's pre-build action list. This file
holds blockers found while building, per docs/01 rule 6.

Status values: OPEN / CLEARED.
Types: CREDENTIAL (owner must supply a key or account), DECISION (owner must choose),
VERIFICATION (built and self-checked, but a claim in the acceptance criteria cannot be
proven in the build container), CONTRADICTION (the docs disagree with themselves).

| # | Type | Ticket | What is blocked | What is needed, and from whom | Status |
|---|---|---|---|---|---|
| V-01 | VERIFICATION | ARB-004 | The acceptance clause "`docker compose up` healthy". The compose file is written and passes `docker compose config`, but this container has the Docker CLI without a running daemon (`/var/run/docker.sock` absent), so no image can be pulled or started. | Owner: run `docker compose up -d` on a machine with Docker running, confirm both services report healthy (`docker compose ps`), then set this row to CLEARED. Nothing in the repo needs changing first. | OPEN |

## Notes

- V-01 does not block later tickets. Application code is written against `DATABASE_URL`
  and `REDIS_URL`, so it does not care whether those point at compose, the Supabase CLI,
  or hosted instances.
