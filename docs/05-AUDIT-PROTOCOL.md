# 05 — AUDIT PROTOCOL

Document: LI-AUD-ARB-0926 v1.0 — 22/09/2026

Run for every ticket before it is marked DONE. Paste the completed checklist into the commit body. A single failed line means the ticket is not done.

## 1. Button and control audit (every page)

For every button, link, toggle, input and form on the page, record in `docs/audit/<page>.md`:

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|

Rules:
1. Every control has a Playwright test that clicks it and asserts the result.
2. No control does nothing. No dead links. No placeholder "#" hrefs.
3. Destructive actions (delete, go live, submit bid, post project, send message) require confirmation and are logged to `events`.
4. Every async action shows a loading state and a success or error message.
5. Every form validates on the client and on the server, with the same rules.
6. Tab order is logical; focus is visible; labels are attached to inputs.

## 2. Copy audit (every sentence)

1. UK English spelling (colour, organisation, licence as noun, analyse).
2. Dates DD/MM/YYYY; times 24-hour SAST; currency ZAR shown as R1 234,56 or R1,234.56 — pick one format in DECISIONS.md and use it everywhere.
3. No claim the product cannot prove. No earnings claims. No scarcity or countdown copy.
4. Error messages say what happened and what to do next.
5. No internal supplier names, prompt text or debug output visible to end users.
6. Every sentence read once aloud (by the reviewer) for sense.

## 3. Numbers audit (anything involving money, counts or rates)

1. Every calculation has a unit test with a hand-worked expected value written in the test.
2. Money uses integer minor units; no floating-point arithmetic on money.
3. Every displayed figure traces to a stored value or a documented formula.
4. Currency conversions show the rate and the timestamp used.
5. Totals reconcile (milestones = bid amount; payments in − payments out − fees = realised margin).

## 4. Data and security audit

1. RLS test for every new table (other org denied read, insert, update, delete).
2. No secrets in the repository (CI runs a secret scanner such as gitleaks).
3. Tokens encrypted at rest; never logged.
4. LIVE_MODE=false proven to block the new outbound path (test).
5. External calls retried with backoff and logged to `events`.

## 5. Facts audit (no guessing)

1. Every marketplace endpoint, field and limit used has an official doc URL in a code comment.
2. Every fee or rule used comes from 02-BLOCKERS answers with source URL and date.
3. Anything unverified is raised as a blocker, not coded around.

## 6. Delivery audit

1. Tests green locally and in CI.
2. Board row updated (Status, SHA).
3. Pushed; `git ls-remote origin main` SHA equals local HEAD.
4. At phase end: tag pushed, preview deployed, four links printed.

## 7. Triple-check

1. Author check — Claude Code runs sections 1–6.
2. Second pass — Claude Code re-runs the Playwright suite from a clean clone of the pushed commit (`git clone` into a temp folder, install, test).
3. Owner check — the owner opens the preview link and the commit, spot-checks at least five controls and three figures, and records sign-off on the phase report issue.
