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

| File | Expected | Actual |
|---|---|---|
| 00-README.md | 2738 | 2738 |
| 01-MASTER-BUILD-PROMPT.md | 18458 | 18458 |
| 02-BLOCKERS.md | 6209 | 6209 |
| 03-IMAGE-GENERATION.md | 3753 | 3753 |
| 04-PROJECT-BOARD.md | 10365 | 10365 |
| 05-AUDIT-PROTOCOL.md | 3371 | 3371 |
| reference/R1-competitor-audit.md | 9577 | 9577 |
| reference/R2-funnel-and-software-intel.md | 8036 | 8036 |
| reference/R3-early-build-brief.md | 9311 | 9311 |

Note for the owner:
- A second, later copy of the same package exists in Drive (folder `1tDIk2rn8ASNjoLkN6ZJhHmBNSfw6RKX8`, the one the shared link in Build.txt points to). File sizes are identical across both copies. The copy named above is the one used. Worth deleting one of the two so there is a single source of truth in Drive as well.
