# Control audit — login.html (ARB-061, ARB-015)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/login.spec.ts`) that exercises it. Supabase Auth and the API are answered at the
network edge with the shapes they return: `POST /auth/v1/token?grant_type=password` (the
request `supabase.auth.signInWithPassword()` makes) and `POST /v1/sessions`
(`apps/api/src/routes/me.ts`, tested against real Postgres in `routes/pages.test.ts`).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the landing page | Goes to index.html | — | — | — | Never | Yes | renders the form with labelled fields and a working brand link | ✅ |
| Input | Email | The person's sign-in address | Sent to Supabase Auth as `email` | — | — | "Is required." / "Must be an email address." attached with aria-describedby; first invalid field focused | While the build has no Supabase project (B-06): the form is disabled and says so | Yes | refuses an empty or malformed form before anything is sent | ✅ |
| Input (password) | Password | The password | Sent as `password`; cleared after a successful sign-in | — | — | "Is required." | as Email | Yes | refuses an empty or malformed form…; signs in with the password grant… | ✅ |
| Button (submit) | Sign in | Validate, sign in, record the session, open the next page | Client checks first, nothing sent on failure; then the password grant with the anon key; session kept in sessionStorage for the tab; `POST /v1/sessions` with the bearer token; then `next` (a page of this app) or dashboard.html | Spinner, aria-busy, disabled | "Signed in. Opening the next page…" then navigation | "Email or password is wrong. Check both and try again." / "Could not reach the sign-in service…" / "The sign-in service answered N…" / "Signed in, but this account is not a member of an organisation…" (session dropped) | While busy; while unconfigured | Yes | signs in with the password grant…; honours a next page of this app…; says plainly when the password is wrong…; a valid login with no membership is turned away…; an unreachable sign-in service is reported, not hidden | ✅ |
| Link | Privacy notice | Open the privacy notice | Goes to privacy.html (ARB-015) | — | — | — | Never | Yes | the brand link and the sign-in link go where they say (e2e/privacy.spec.ts) | ✅ |

Page-level: someone who already has a session is sent on rather than shown the form
(test "someone already signed in is sent on, not shown the form"). `next` is honoured
only for a page of this app; an outside URL goes to the dashboard (test "honours a next
page of this app, and ignores anything else"). No horizontal scroll at 380 px. UK
English throughout. The project URL and anon key are the public browser values, read
from `.env` at build time (`apps/web/vite.config.js`); no secret is in the page.

Not present, on purpose: a password-reset link. Supabase's recovery email needs the
project (B-06) and an email template the owner approves; no control is offered that
would do nothing.

Known limit: the configured path is what Playwright covers. The unconfigured state
(no SUPABASE_URL at build time) disables the three controls with the message above;
it is a build-time branch and is read, not run, by the suite.
