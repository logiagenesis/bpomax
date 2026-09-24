# Control audit — upwork-callback.html (ARB-300)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/upwork-callback.spec.ts`) that exercises it. This is where Upwork sends the browser
back after the person approves access (the redirect URI registered with the key,
`${APP_URL}/upwork-callback.html`, D-066), with `?code=` in the address
(https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#auth-authorizationCodeGrant-obtainingAuthorizationCode).
The page hands the code to `POST /v1/platform-accounts/upwork/callback`
(`apps/api/src/routes/upwork-accounts.ts`, tested against real Postgres and the Upwork
stand-in) and shows the answer. The browser never sees a token. The account is used to
read jobs only.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×11, Sign out | as dashboard.md | as dashboard.md | as dashboard.md | — | — | — | — | Yes | Back to Settings goes to Settings | ✅ |
| Link | Back to Settings | Return to the settings page | Goes to settings.html | — | — | — | Never | Yes | Back to Settings goes to Settings | ✅ |
| Status (`role="status"`, no control) | — | Say what happened | On load the code is read from the address and removed from it and from the history, then sent once to the API | "Finishing the connection…" | "Connected the Upwork account <name>. It is used to read jobs only." | The API's message as it is (a 409 for a stale attempt or a second account; a 502 says nothing was connected); with no code: "Upwork did not send back an authorisation code, so nothing was connected. Go back to Settings and try again." and nothing is sent | — | Not applicable | hands the code to the API, says which account was connected, and clears the code from the address; without a code nothing is sent, and the page says what to do; the API’s refusal is shown as it is | ✅ |

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px
(test "at 380 px wide the page does not scroll sideways"); UK English.
