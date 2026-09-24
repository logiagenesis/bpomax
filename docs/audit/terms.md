# Control audit — terms.html (ARB-400)

Per docs/05 section 1. The page shows the owner's approved terms of service from
`terms.json`, in the privacy notice's shape (`parseTermsOfService`, `@arbitron/core`),
and writes none of the wording. The committed file is pending (docs/BLOCKERS.md D-16).
Tests in `e2e/signup.spec.ts`.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the landing page | Goes to index.html | — | — | — | Never | Yes | the terms page says they are pending, names D-16, and shows no wording | ✅ |
| Status (no control) | — | Show the terms, or say they are pending | Pending: the note naming D-16, no wording; approved: version, approver and date (DD/MM/YYYY), then each section | — | "Version V, approved by N on DD/MM/YYYY." | "The published terms are incomplete, so none are shown…" / "The terms could not be loaded (…)…" | — | Not applicable | the terms page says they are pending…; the terms page shows them with who approved them and when | ✅ |
| Link | Create an account | Go to sign-up | Goes to signup.html | — | — | — | Never | Yes | the terms page says they are pending… (every link checked) | ✅ |
| Link | Sign in | Go to sign-in | Goes to login.html | — | — | — | Never | Yes | as above | ✅ |

Page-level: public, no session needed; no horizontal scroll at 380 px (shared layout
with privacy.html); UK English.
