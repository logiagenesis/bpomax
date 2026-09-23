# Control audit — analytics.html (ARB-320)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/analytics.spec.ts`) that exercises it. The API is an in-memory copy, at the network
edge, of `apps/api/src/routes/analytics.ts` (tested against real Postgres and raw SQL over
the base tables in `routes/analytics.test.ts`): `GET /v1/analytics?by=&since=`. The
figures are grouped by `aggregateAnalytics` in `@arbitron/core`, hand-worked in
`packages/core/src/analytics.test.ts`.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×10, Sign out | as dashboard.md | as dashboard.md | `aria-current="page"` on Analytics | — | — | — | — | Yes | shows each group’s figures as the API worked them, with the total, and every link goes somewhere | ✅ |
| Select | Group by | Category, Template, Supplier or Scanner | Sent with Apply as `by` | — | — | — | Never | Yes | Group by and a start date ask the API again, and land in the address bar | ✅ |
| Input | Bids sent since (DD/MM/YYYY) | Count only bids sent from that SAST day | Read as DD/MM/YYYY and sent as an ISO day; empty means every bid | — | — | "Must be a real date as DD/MM/YYYY." on the field; nothing is asked | Never | Yes | a false date is refused on its field, and nothing is asked | ✅ |
| Button (submit) | Apply | Read the figures again | `GET /v1/analytics?by=&since=`; the table, the total and the unconverted note rebuilt; `?by=&since=` in the address bar | Spinner, aria-busy, disabled | "Counted N bids by <grouping>." / "No bids sent yet." | The API's message | While busy | Yes | Group by and a start date…; a linked view opens with its grouping and date; with no bids sent… | ✅ |

Figures (docs/05 section 3): each rate is shown with its numerator and denominator
("66,7 % (2 of 3)"), and a rate with nothing under it says "No data (0 of 0)", never 0 %;
realised margin is `formatMoney` of the API's minor units in rand; model cost per reply is
nano-US-dollars shown as US dollars to the millionth ("USD 0,00225"), or "No replies".
Payments not in rand with no rate are counted in a note, and left out of the margin. The
page recalculates nothing.

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px;
`?by=&since=` restores the view. A viewer reads the same figures.
