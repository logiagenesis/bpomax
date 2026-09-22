# Control audit — audit-log.html (ARB-062)

Per docs/05 section 1. Tests are in `e2e/audit-log.spec.ts`, against a mocked API: no
real session exists until B-06. The API side is tested in
`apps/api/src/routes/events-export.test.ts`.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Select | Type | Choose one event type | Sent as `type` on Apply | — | — | — | Never | Yes | filters by type, actor and date… | ✅ |
| Select | Actor | Choose a person from the log | Sent as `actor` on Apply | — | — | — | Never | Yes | filters by type, actor and date… | ✅ |
| Input | From / To | DD/MM/YYYY, SAST days | Sent as UTC bounds; the whole "To" day is included | — | — | Field message, focus, no request | Never | Yes | filters…; refuses a date it cannot read… | ✅ |
| Button | Apply filters | Reload page 1 with the filters | As expected | Disabled while loading, "Loading…" | Table | Status message in words | While loading | Yes | filters by type, actor and date… | ✅ |
| Button | Clear filters | Reset and reload everything | As expected | As Apply | Table | As Apply | Never | Yes | clear resets the filters… | ✅ |
| Button | Export CSV | Download the filtered log | Downloads `audit-log-YYYYMMDD.csv` with the filters in force | Busy, disabled, "Preparing the export…" | "Exported N entries to …" | Message in words; a capped export says so | While exporting | Yes | exports the filtered log…; says so when an export was cut off… | ✅ |
| Button | Older / Newer | Page by 50 | Offset ±50 | Disabled while loading | "Entries X to Y" | — | Newer on page 1; Older on a short page | Yes | pages older and newer… | ✅ |
| Disclosure | Show | Reveal the payload | Shows pretty-printed JSON | — | — | — | Only rendered when a payload exists | Yes (native `<details>`) | the details disclosure shows the payload | ✅ |
| Links | Arbitron, Audit log | Navigate | As expected | — | — | — | Never | Yes | the links on the page go somewhere | ✅ |

Page-level: signed-out (401) and server-failure (500) messages in words, empty state, and
no sideways scroll at 380 px, each with a test.
