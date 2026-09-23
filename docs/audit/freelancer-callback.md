# Control audit — freelancer-callback.html (ARB-020)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/freelancer-callback.spec.ts`) that exercises it. This is where Freelancer.com sends
the browser back after the person approves access (`FREELANCER_REDIRECT_URI`), with
`?code=` in the address (https://developers.freelancer.com/docs/authentication/generating-access-tokens,
"Receive Authorization Response"). The page hands the code to
`POST /v1/platform-accounts/freelancer/callback` (`apps/api/src/routes/platform-accounts.ts`,
tested against real Postgres and an in-process stand-in of Freelancer.com) and shows the
answer. The browser never sees a token (D-041, D-044).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×10, Sign out | as dashboard.md | as dashboard.md | as dashboard.md | — | — | — | — | Yes | Back to Settings goes to Settings | ✅ |
| Link | Back to Settings | Return to the settings page | Goes to settings.html | — | — | — | Never | Yes | Back to Settings goes to Settings | ✅ |
| Status (`role="status"`, no control) | — | Say what happened | On load the code is read from the address and removed from it and from the history (`history.replaceState`), then sent once to the API | "Finishing the connection…" | "Connected the Freelancer.com account <username>." | The API's message as it is (a 409 for a stale or missing attempt says "Start again from Settings"; a 502 says nothing was connected); with no code: "Freelancer.com did not send back an authorisation code, so nothing was connected. Go back to Settings and try again." and nothing is sent | — | Not applicable | hands the code to the API, says which account was connected, and clears the code from the address; without a code nothing is sent, and the page says what to do; the API’s refusal is shown as it is | ✅ |

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px
(test "at 380 px wide the page does not scroll sideways"); UK English.
