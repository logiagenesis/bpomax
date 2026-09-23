# Control audit — dashboard.html (ARB-061)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/dashboard.spec.ts`) that exercises it. The API is mocked at the network edge with
the shape `GET /v1/dashboard` returns (`apps/api/src/routes/dashboard.ts`, whose
formulas are written beside its fields and hand-worked against real Postgres in
`routes/pages.test.ts`). The page formats; it never calculates.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the dashboard | Goes to dashboard.html | — | — | — | Never | Yes | shows every figure… (every link goes somewhere) | ✅ |
| Nav links ×11 | Dashboard, Feed, Approvals, Conversations, Suppliers, Sourcing, Pipeline, Templates, Analytics, Settings, Audit log | Go to that page; current page marked | Go there; `aria-current="page"` on Dashboard | — | — | — | Never | Yes | shows every figure… | ✅ |
| Button | Sign out | End the session and go to login | `POST /auth/v1/logout` with the bearer token (best effort), sessionStorage cleared, login.html | Disabled while leaving | Login page shown, not bounced back | The local session is cleared even if Supabase cannot be reached | Never | Yes | sign out revokes the session with Supabase, clears it, and goes to login | ✅ |
| Button | Refresh | Ask the API again | `GET /v1/dashboard`, tiles re-rendered | Spinner, aria-busy, disabled | "Figures are up to date." | The API's message, e.g. "The API refused the request: boom." | While busy | Yes | refresh asks the API again; an API failure is shown in the status line | ✅ |
| Link | N sent this month. Open approvals | Go to the approvals queue | Goes to approvals.html | — | — | — | Never | Yes | the bids tile links to approvals | ✅ |

Figures (docs/05 section 3): revenue in, paid out and realised margin in rand
(`R3 900,00`), pipeline value and retainers per currency, replies, win rate as a
percentage with a decimal comma (`50,0%`) and the won/lost counts beside it, bids waiting
and sent. A payment in another currency with no stored rate is listed under "Not counted
in rand" rather than guessed into a total (test "shows every figure formatted the one way
the app allows"). Zero and "no decisions yet" are shown as such (test "an empty month
reads as zero…").

Page-level: without a session the page goes to `login.html?next=dashboard.html`; a
session the API answers 401 to is dropped and the page goes there too (two tests). The
person, their role and their org are shown in the header from `GET /v1/me`. No
horizontal scroll at 380 px.
