# Control audit — onboarding.html (ARB-400)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/onboarding.spec.ts`) that exercises it. The API is answered at the network edge in
the shapes `POST /v1/orgs` and `GET /v1/onboarding` return (`apps/api/src/routes/orgs.ts`,
tested against real Postgres with RLS on in `orgs.test.ts`; the database function in
`packages/db/src/signup.test.ts`).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the dashboard | Goes to dashboard.html (which sends someone with no org back here) | — | — | — | Never | Yes | a signed-in page sends someone in no organisation here | ✅ |
| Button | Sign out | End the session | As on every signed-in page (`signOut`), then login.html | Disabled while signing out | Login page | — | While busy | Yes | (shared behaviour; login.md) | ✅ |
| Input | Organisation name | The new org's name | Trimmed, sent as `name` | — | — | "Is required." / "Must be at most 100 characters." (the same rule as the API and `app.create_org`); first invalid field focused | Never | Yes | checks the form before sending it | ✅ |
| Input | Country | Two-letter country code | Upper-cased, sent as `countryCode`; defaults to ZA | — | — | "Must be a two-letter ISO 3166-1 code, such as ZA." | Never | Yes | someone in no organisation is offered the form…; checks the form before sending it | ✅ |
| Button (submit) | Create organisation | Create the org with the person as owner | `POST /v1/orgs`; then `POST /v1/sessions` records the sign-in; then the steps load | Spinner, aria-busy, disabled | "<name> is created, and you are its owner." and the steps | The API's message as it is (409 already in an org; 403 no application user; 422 against the fields) | While busy | Yes | creates the organisation, records the sign-in, then lists the steps; a refusal from the API is shown as it is | ✅ |
| Links ×6 (one per step) | Create your organisation / Set your margin rules and fee table / Connect Freelancer.com / Add a saved search / Add a bid template / Link Telegram | Go where the step is done | settings.html and its section headings, templates.html | — | Badge "Done" | Badge "To do"; "Optional" for Telegram | Never | Yes | a member sees each step, ticked from the org s rows, each linked to its page | ✅ |
| Link | Go to the dashboard | Leave onboarding | Goes to dashboard.html | — | — | — | Never | Yes | a member sees each step… (every link checked) | ✅ |

Page-level: no session → login with `next=onboarding.html`; 401 → login (test "an
expired session goes back to login"); a member never sees the form, and someone in no org
never sees the steps; the summary counts required steps only (tests "a member sees each
step…", "says when everything required is done"); no horizontal scroll at 380 px; UK
English.

Every step is read from the org's own rows (`onboardingSteps` in `@arbitron/core`): the
margin rules and fee table in `settings`, a `connected` Freelancer.com account, a
scanner, an active template with an active variant, and the person's linked Telegram
chat. Nothing is ticked by hand.
