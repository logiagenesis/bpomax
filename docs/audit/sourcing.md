# Control audit — sourcing.html (ARB-201)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/sourcing.spec.ts`) that exercises it. The API is an in-memory copy, at the network
edge, of `apps/api/src/routes/sourcing.ts` (tested against real Postgres in
`routes/sourcing.test.ts`): `GET /v1/sourcing-requests`, `GET /v1/sourcing-requests/:id`
and `PATCH /v1/sourcing-requests/:id/candidates/:candidateId`. The scores shown are the
ones hand-worked in `packages/core/src/sourcing.test.ts`. A request starts from the
conversations page (Start sourcing, audited in `conversations.md`).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×8, Sign out | as dashboard.md | as dashboard.md | `aria-current="page"` on Sourcing | — | — | — | — | Yes | lists the requests with where each stands, and every link goes somewhere | ✅ |
| Button | Refresh | Read the requests again | `GET /v1/sourcing-requests` | Spinner, aria-busy, disabled | "Loaded N sourcing requests." / "No sourcing requests yet." | "Not signed in…" / "Could not reach the API…" / the API's message | While busy | Yes | lists the requests…; an empty list says what to do | ✅ |
| Button (per request) | Open (aria-label "Open the sourcing request for <brief>") | Show the ranking | `GET /v1/sourcing-requests/:id`; row marked `aria-current`; `?request=` in the address bar | Spinner, aria-busy, disabled | "Opened the sourcing request for <brief>: N suppliers ranked, M not ranked." | The API's message as it is ("…no such sourcing request.") | While busy | Yes | Open shows the ranking in order…; a linked view opens its request; a request the API cannot find says so | ✅ |
| Button (per candidate) | Shortlist / Remove (aria-label "Shortlist <supplier>" / "Remove <supplier> from the shortlist") | Add the supplier to the shortlist, or take it off | `PATCH …/candidates/:id` with `{ shortlisted }`; the request's status follows (open ↔ shortlisting); the list re-read | Spinner, aria-busy, disabled | "Shortlisted <supplier>." / "Removed <supplier> from the shortlist." | The API's refusal as it is | Once a supplier is chosen or the request is closed (title says which); for a viewer (title says so); while busy | Yes | Shortlist and Remove ask the API…; the API's refusal is shown as it is; a request with a supplier chosen keeps its shortlist fixed…; a viewer can read everything but not shortlist | ✅ |

Figures (docs/05 section 3): each rate is `formatMoney` of the rate card's stored minor
units, fixed or an hour as the brief is priced; the score is the stored total out of 100
with its five stored parts; every reason is the sentence stored with the candidate when it
was ranked. Nothing is recalculated on the page. The weights are named constants in
`@arbitron/core` (rate 40, turnaround 20, quality 20, time zone 10, payment after delivery
10) and every score is hand-worked in a test.

Not a destructive action: shortlisting sends nothing and can be undone. Posting to a
marketplace is ARB-202 and ARB-203, which carry the approval and the live gate.

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px;
`?request=` restores the view.
