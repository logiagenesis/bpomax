# Control audit — audit-log.html (ARB-062)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/audit-log.spec.ts`) that exercises it. The API is mocked at the network edge with the
exact shapes the three audit routes return: `GET /v1/events` (a page of the log),
`GET /v1/events/actors` (the people who appear in it) and `GET /v1/events.csv` (the export).
The routes themselves are tested against real Postgres in `apps/api/src/server.test.ts` and
`apps/api/src/routes/events-export.test.ts`, and every one of them is scoped to the
signed-in organisation by row-level security.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the dashboard | Goes to dashboard.html | — | — | — | Never | Yes | every link goes somewhere | ✅ |
| Nav links ×10 | Dashboard, Feed, Approvals, Conversations, Suppliers, Sourcing, Pipeline, Analytics, Settings, Audit log | Go to that page; current page marked | Go there; `aria-current="page"` on Audit log | — | — | — | Never | Yes | every link goes somewhere | ✅ |
| Select | Type | Restrict to one event type | Sends `type=` to the API; address bar updated | — | — | — | Never | Yes | filters by type…; offers every event type… | ✅ |
| Date input | From | Start of that South African day | Sends `from=` as 00:00 SAST in UTC | — | — | "Enter a date." | Never | Yes | filters by date as whole South African days | ✅ |
| Date input | To | End of that day, inclusive | Sends `to=` as the next midnight SAST | — | — | "Enter a date." / "Must not be before the From date." | Never | Yes | filters by date…; refuses a bad filter… | ✅ |
| Select | Actor | Restrict to one person | Options come from `/v1/events/actors` (name, else email); sends `actor=` | — | — | If the people list fails the select offers only "Everyone" and the log still loads | Never | Yes | offers the people in the log…; still loads the log when the people list fails | ✅ |
| Select | Outcome | Restrict to ok / error / blocked / skipped | Sends `outcome=` | — | — | — | Never | Yes | filters by outcome | ✅ |
| Button (submit) | Apply filters | Validate, then load page 1 | Errors attached with aria-describedby, first invalid field focused, nothing sent; else loads | Spinner, aria-busy, disabled | "Loaded N events." / "No events match these filters." | "Not signed in…" / "Could not reach the API…" | While busy | Yes | filters by…; refuses a bad filter…; says so plainly when… | ✅ |
| Button | Clear filters | Reset every field and reload | Fields cleared, errors cleared, page 1 loaded, address bar cleared | Spinner, aria-busy, disabled | "Loaded N events." | as Apply | While busy | Yes | clear puts everything back | ✅ |
| Button | Export CSV | Download every matching row | Fetches `/v1/events.csv` with the current filter (no paging); saves the file under the name the API gives it | Spinner, aria-busy, disabled | "Exported N events." / "Exported the first N matching events. Narrow the filter for the rest." (API cap, 10 000 rows) | as Apply | Until rows are shown; while busy | Yes | exports the filtered log…; says when an export hit the cap | ✅ |
| Button | Previous | Show the previous page | Offset − 25, reload | Spinner, aria-busy, disabled | "Loaded N events." | as Apply | On page 1; while busy | Yes | pages through results | ✅ |
| Button | Next | Show the next page | Offset + 25, reload | Spinner, aria-busy, disabled | "Loaded N events." | as Apply | When fewer than 25 rows came back; while busy | Yes | pages through results | ✅ |

Page-level: the log is read-only here — there is no control that can write to it, because
`events` is append-only (migrations 0007 and 0008). The filter lives in the address bar, so
a view can be linked to (test "a linked view restores its filters"). No horizontal scroll at
380 px (test "at 380 px wide…"). Every sentence is UK English; dates are DD/MM/YYYY in SAST
(test "lists events newest first…"). The CSV carries both the SAST date and the stored UTC
timestamp, and defuses cells beginning with `=`, `+`, `-`, `@`, tab or carriage return
(`apps/api/src/routes/events-csv.ts`).

Sign-in (ARB-061): the page carries the session's bearer token like every other page,
and its navigation is the app's (Dashboard, Feed, Approvals, Settings, Audit log). It
does not redirect on its own: without a session the API answers 401 and the page shows
"Not signed in. Sign in and try again." rather than hiding it.
