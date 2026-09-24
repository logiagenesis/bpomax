# Control audit — affiliates.html (ARB-430)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/affiliates.spec.ts`) that exercises it. The API is answered at the network edge in
the shapes `apps/api/src/routes/affiliates.ts` returns, tested against real Postgres in
`affiliates.test.ts`, which follows one code from the click, through sign-up, to a paid
plan through the Paystack stand-in (D-071).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×11, Sign out | as dashboard.md | as dashboard.md | as dashboard.md | — | — | — | — | Yes | lists each code with its link and its funnel… (every link checked) | ✅ |
| Input | Referral code | The code in the link | Sent as `code`; checked by `validateAffiliate` first | — | — | "Must be 3 to 40 letters, digits or hyphens…"; "That code is already in use. Choose another." (409) | Hidden with the form for anyone but the house org's owner | Yes | adds an affiliate, checking the form first; a code in use is refused in the API s words | ✅ |
| Input (email) | Affiliate's email (optional) | Who the affiliate is | Sent as `ownerEmail` | — | — | "Must be an email address." | as above | Yes | adds an affiliate, checking the form first | ✅ |
| Input | Commission (%, optional) | The agreed commission | Sent as `commissionPct`; empty records none | — | — | "Must be a percentage from 0 to 100…" | as above | Yes | adds an affiliate, checking the form first | ✅ |
| Button (submit) | Add affiliate | Create the code | `POST /v1/affiliates`; the list reloads | Spinner, aria-busy, disabled | "Added <code>. Its link is in the list below." | The API's message | While busy | Yes | adds an affiliate…; a code in use is refused… | ✅ |
| Button (per row) | Switch off / Switch on (aria-label names the code) | Stop or restart counting new clicks | `PATCH /v1/affiliates/:id {active}`; the list reloads | Spinner, aria-busy, disabled | "The link for <code> is off: new clicks on it no longer count." / "…is on again." | The API's message | While busy | Yes | a link can be switched off, and says what that means | ✅ |
| Link | Back to Settings | Return to Settings | Goes to settings.html | — | — | — | Never | Yes | lists each code… (every link checked) | ✅ |

Page-level: the table shows each code with its link (the site address with `?ref=`), the
affiliate, the commission as recorded (12,5%, or "Not recorded"), clicks, sign-ups, paid
orgs and the last click in DD/MM/YYYY HH:MM SAST; anyone but the house org's owner is told
whose programme it is and sees no form (test "anyone but the house org s owner…"); no
horizontal scroll at 380 px; UK English. Settings shows the house org's owner an
"Affiliate programme" link, and nobody else.

The referral journey outside this page, each with its test in the same spec: the landing
page records a click, keeps its id and takes the code out of the address; a code that is
not a code is dropped without a request; the org created afterwards carries the click,
and the browser forgets it.
