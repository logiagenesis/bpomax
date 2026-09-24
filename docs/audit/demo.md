# Control audit — demo mode (ARB-070, D-043)

Demo mode exists only in the demo build (`pnpm build:web:demo`), which Vercel serves
while the Supabase and API credentials are missing. Every page's own controls behave as
their own audit files describe, against sample data answered inside the browser. Demo
mode adds one control of its own. Tests are in `e2e/demo.spec.ts`
(`e2e/playwright.demo.config.ts`).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Button (in the banner on every page) | Reset the sample data | Put the sample data back as it started | Clears this tab's demo store and reloads the page | — | The page reloads with the original sample | — | Never | Yes | an approval is kept for the tab and appears in the audit log; reset brings the sample back | ✅ |

Page-level, each with its test: every signed-in page opens from its own link with sample
data and the banner, and makes no request outside the site. The landing, login, sign-up,
onboarding, privacy, terms and style-guide pages show the banner. Any email and password sign in. Settings keeps
live mode off until every rule is set. Onboarding reads each step from the tab's sample
rows (test "onboarding in the demo reads each step from the tab’s sample rows"), and
sign-up stays closed while the terms are pending (test "sign-up in the demo stays closed
while the terms are pending"); the demo's sign-up answers as a project that asks for
email confirmation, so it never pretends an account was made (ARB-400).
