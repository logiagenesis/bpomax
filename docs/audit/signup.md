# Control audit — signup.html (ARB-400)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/signup.spec.ts`) that exercises it. Supabase Auth is answered at the network edge in
the shapes `POST /auth/v1/signup` returns: the user alone when the project asks for email
confirmation, a session when it does not (the request `supabase.auth.signUp()` makes,
https://supabase.com/docs/reference/javascript/auth-signup; supabase-js
`packages/core/auth-js/src/GoTrueClient.ts`, `signUp`). Error codes are the ones listed
in supabase-js `packages/core/auth-js/src/lib/error-codes.ts`. The form stays closed
while the terms of service are pending (D-068, docs/BLOCKERS.md D-16).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link | Arbitron | Go to the landing page | Goes to index.html | — | — | — | Never | Yes | the login page links here, and here links back | ✅ |
| Input | Email | The new account's address | Sent as `email` | — | — | "Is required." / "Must be an email address." / "Is not accepted by the sign-up service." (Supabase `email_address_invalid`); first invalid field focused | While the terms are pending or unreadable; while the build has no Supabase project (B-06); after a confirmation email is sent | Yes | refuses an incomplete form before anything is sent; says what email_address_invalid means | ✅ |
| Input (password) | Password | The new password | Sent as `password`; cleared after success | — | — | "Is required." / "Is too weak: <Supabase's reason>." (`weak_password`) | as Email | Yes | refuses an incomplete form…; says what weak_password means | ✅ |
| Input (password) | Password again | Guard against a typing slip | Compared with Password, never sent | — | — | "Is required." / "Must match the password." | as Email | Yes | refuses an incomplete form before anything is sent | ✅ |
| Checkbox | I accept the terms of service (version V, approved DD/MM/YYYY) | Record acceptance of the published version | The version and the time are sent as user metadata (`data.terms_version`, `data.terms_accepted_at`) | — | — | "Must be accepted to create an account." | as Email | Yes | the form names the version being accepted; signs up with the documented request… | ✅ |
| Link (in the checkbox label) | terms of service | Read the terms | Goes to terms.html | — | — | — | Never | Yes | the form names the version being accepted | ✅ |
| Button (submit) | Create account | Validate, then create the identity | Client checks first, nothing sent on failure; then `POST /auth/v1/signup` with the anon key and `redirect_to` = login.html; a session is kept and onboarding opens; no session means an email was sent | Spinner, aria-busy, disabled | "Check your email: a confirmation link is on its way to <address>. Open it, then sign in to set up your organisation." (form then closed) / onboarding.html | "An account already uses this email address. Sign in instead." / "Too many sign-up emails have been sent…" / "Sign-up is switched off on this service." / "Too many attempts…" (429) / "The sign-up service answered N…" / "Could not reach the sign-up service…" | While busy; as Email | Yes | signs up with the documented request and, when confirmation is on, says to check email; when the project signs people in straight away, keeps the session and opens onboarding; says what user_already_exists / over_email_send_rate_limit / signup_disabled mean; an unreachable sign-up service is reported, not hidden | ✅ |
| Link | Sign in | Go to sign-in | Goes to login.html | — | — | — | Never | Yes | the login page links here, and here links back | ✅ |
| Link | Privacy notice | Open the privacy notice | Goes to privacy.html | — | — | — | Never | Yes | the form names the version being accepted (every link checked) | ✅ |

Page-level: pending terms close the form with "Sign-up opens once the terms of service
are published. Until then, an owner can add you to their organisation." and nothing is
sent (test "sign-up is closed, says why, and sends nothing"); terms that break the rule
close it with an error (test "terms that cannot be read keep sign-up closed"); someone
already signed in goes to onboarding; no horizontal scroll at 380 px; UK English.

Supabase returns an obfuscated user for an address that already has a confirmed account
when email confirmation is on (GoTrueClient `signUp` remarks), so the page cannot and
does not say whether an address is taken in that case: it says to check the email.
