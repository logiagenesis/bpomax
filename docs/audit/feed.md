# Control audit — feed.html (ARB-061)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/feed.spec.ts`) that exercises it. The API is mocked at the network edge with the
shapes `GET /v1/jobs` and `POST /v1/jobs/:id/queue-bid` return
(`apps/api/src/routes/jobs.ts`, tested against real Postgres in `routes/pages.test.ts`).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×10, Sign out | as dashboard.md | as dashboard.md | `aria-current="page"` on Feed | — | — | — | — | Yes | lists jobs with the stored score… | ✅ |
| Select | Verdict | Restrict to go / caution / skip / not scored | Sends `verdict=` to the API; address bar updated | — | — | — | Never | Yes | the verdict filter sends exactly that verdict…; a linked view restores its filter | ✅ |
| Button (submit) | Apply filter | Load page 1 with the filter | `GET /v1/jobs?verdict=&limit=25&offset=0` | Spinner, aria-busy, disabled | "Loaded N jobs." / "No jobs match this filter." | "Not signed in…" / "Could not reach the API…" / the API's message | While busy | Yes | the verdict filter…; an empty filter says so | ✅ |
| Button | Refresh | Ask again with the same filter and page | Same request | as Apply | as Apply | as Apply | While busy | Yes | refresh asks again… | ✅ |
| Button | Previous | Show the previous page | Offset − 25 | as Apply | as Apply | as Apply | On page 1; while busy | Yes | pages through results | ✅ |
| Button | Next | Show the next page | Offset + 25 | as Apply | as Apply | as Apply | When fewer than 25 rows came back; while busy | Yes | pages through results | ✅ |
| Button (per row) | Queue bid (aria-label "Queue bid for <job>") | Ask for a bid to be drafted for approval | `POST /v1/jobs/:id/queue-bid`; the API drafts from a passed margin, or scores an unscored job first; rows refreshed with the message kept | Spinner, aria-busy, disabled | "A bid for “<job>” is being drafted. It will appear in Approvals." / "“<job>” is being scored first…" | The API's refusal as it is, e.g. "This job was scored skip, so no bid is drafted for it." | While a bid is queued, approved or sent (title says which); for a viewer (title says so); while busy | Yes | Queue bid asks the API…; a job that is scored first says so; the API’s refusal is shown as it is; Queue bid is off while a bid is already in play…; a viewer can read the feed but every Queue bid is off | ✅ |

Figures (docs/05 section 3): budget as a range in the job's currency, per hour when
hourly (`USD 500,00 per hour`); score with its verdict badge and any flags; the
estimate with its method (`R1 500,00 (rate card)`); the margin with its percentage and a
Passed/Failed badge carrying the stored reason; the bid's state. Every value is the
API's; nothing is derived on the page.

Not a destructive action: Queue bid sends nothing. The bid it asks for waits in
Approvals, and the sender still holds the live gate and the allowance (D-032), so no
confirmation is asked here (docs/05 section 1.3 names the actions that need one).

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px.
