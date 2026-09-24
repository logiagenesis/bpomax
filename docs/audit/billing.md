# Control audit — billing.html (ARB-420)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/billing.spec.ts`) that exercises it. The API is answered at the network edge in the
shapes `GET /v1/billing` and `POST /v1/billing/checkout` return
(`apps/api/src/routes/billing.ts`, tested against real Postgres and the Paystack and
Stripe stand-ins in `billing.test.ts`). The customer pays on the provider's own page. The
plan starts only when the provider's signed webhook confirms the payment (D-070).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×11, Sign out | as dashboard.md | as dashboard.md | as dashboard.md | — | — | — | — | Yes | lists each plan with its monthly limits… (every link checked) | ✅ |
| Button (per plan and currency) | Pay R499,00 with Paystack / Pay USD 29,00 with Stripe (the plan's own price, in the one money format) | Start paying for that plan in that currency | `POST /v1/billing/checkout {plan, currency}`; the answer's `url` (the provider's hosted checkout) is opened | Spinner, aria-busy, disabled | The provider's page opens | The API's message as it is (502 from the provider, "Nothing was charged."; 409; 422; 503 naming B-15) | Off, with the reason as its title, for: an operator or viewer ("Only an owner…"); the house org; an org that already has a plan (one plan per org, D-070); a provider without its keys (the reason names B-15) | Yes | Pay asks for the checkout in that currency…; a provider refusal is shown as it is; a plan with a failed payment shows when the grace period ends; an operator sees the plans with every Pay button off…; a provider without its keys has its button off… | ✅ |
| Link | Back to Settings | Return to Settings | Goes to settings.html | — | — | — | Never | Yes | Settings links here | ✅ |
| Status (no control) | — | Say where the org stands | The plan, its status and the provider; a failed payment says when the grace period ends (DD/MM/YYYY), or that none is set; the house org is not billed; no plan gives the reason | — | "Billing loaded." / back from the provider: "Thank you. The plan starts as soon as the payment provider confirms the payment…" / "The checkout was cancelled. Nothing was charged." | API message | — | Not applicable | back from the provider, the page says the webhook decides…; a cancelled checkout says nothing was charged; the house org is told it is not billed… | ✅ |

Page-level: no session → login with `next`; 401 → login; the `?checkout=` the provider
returns with is removed from the address; with no plans published the page names D-12;
no horizontal scroll at 380 px; UK English. Settings' Plan and usage section links here
("Choose or pay for the plan").
