# Control audit — sourcing.html (ARB-201; ARB-202 to ARB-204; re-walked for ARB-210)

Per docs/05 section 1. Every control on the page, and the Playwright test (in
`e2e/sourcing.spec.ts`) that exercises it. The API is an in-memory copy, at the network
edge, of `apps/api/src/routes/sourcing.ts` (tested against real Postgres in
`routes/sourcing.test.ts`): `GET /v1/sourcing-requests`, `GET /v1/sourcing-requests/:id`,
`PATCH /v1/sourcing-requests/:id/candidates/:candidateId` and, for ARB-204,
`POST /v1/sourcing-requests/:id/candidates/:candidateId/reprice`. The scores shown are the
ones hand-worked in `packages/core/src/sourcing.test.ts`. A request starts from the
conversations page (Start sourcing, audited in `conversations.md`).

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Link, nav links ×11, Sign out | as dashboard.md | as dashboard.md | `aria-current="page"` on Sourcing | — | — | — | — | Yes | lists the requests with where each stands, and every link goes somewhere | ✅ |
| Button | Refresh | Read the requests again | `GET /v1/sourcing-requests` | Spinner, aria-busy, disabled | "Loaded N sourcing requests." / "No sourcing requests yet." | "Not signed in…" / "Could not reach the API…" / the API's message | While busy | Yes | lists the requests…; an empty list says what to do | ✅ |
| Button (per request) | Open (aria-label "Open the sourcing request for <brief>") | Show the ranking | `GET /v1/sourcing-requests/:id`; row marked `aria-current`; `?request=` in the address bar | Spinner, aria-busy, disabled | "Opened the sourcing request for <brief>: N suppliers ranked, M not ranked." | The API's message as it is ("…no such sourcing request.") | While busy | Yes | Open shows the ranking in order…; a linked view opens its request; a request the API cannot find says so | ✅ |
| Button (per candidate) | Reprice (aria-label "Reprice the bid with <supplier>’s quote") | Judge the bid's margin with this candidate's quote as the supplier cost | `POST …/candidates/:id/reprice` (202); the reprice worker writes a `candidate_quote` estimate and a margin evaluation (ARB-204, D-056); the request re-read; the Margin cell shows the stored margin and whether it clears the rule, or "Not priced: <reason>" with the rules named | Spinner, aria-busy, disabled | "Asked for the bid to be priced with <supplier>’s quote. The margin shows in the row once the worker has run; reopen the request to see it." | The API's refusal as it is (503 while the workers are not running, B-12; 409 with no quote or no job) | For a viewer (title says so); a candidate with no quote (title says so); while busy | Yes | Reprice asks the API for the candidate’s quote, then shows the margin…; a reprice blocked by an unanswered rule says which rule…; the API’s refusal to reprice is shown as it is; Reprice is closed to a viewer…; Reprice is closed to a candidate with no quote… | ✅ |
| Button (per candidate) | Choose (aria-label "Choose <supplier> as the supplier") | Open a draft delivery order at the candidate's quote (docs/01 section I "choose supplier", ARB-310) | Dialog naming the quote → `POST …/candidates/:id/choose` (201); the request becomes Supplier chosen; a link to the order on the pipeline page | Spinner, aria-busy, disabled | "Chose <supplier>. The delivery order is open on the pipeline page." with "Open the delivery order" | The API's refusal as it is (no pipeline item for the job; the job already has an order) | Once a supplier is chosen or the request is closed; a candidate with no quote; for a viewer (title says which) | Yes (Cancel has focus) | Choose asks first, opens a delivery order at the quote…; Choose is closed to a viewer, a candidate with no quote, and a request with a supplier chosen | ✅ |
| Button (per candidate) | Shortlist / Remove (aria-label "Shortlist <supplier>" / "Remove <supplier> from the shortlist") | Add the supplier to the shortlist, or take it off | `PATCH …/candidates/:id` with `{ shortlisted }`; the request's status follows (open ↔ shortlisting); the list re-read | Spinner, aria-busy, disabled | "Shortlisted <supplier>." / "Removed <supplier> from the shortlist." | The API's refusal as it is | Once a supplier is chosen or the request is closed (title says which); for a viewer (title says so); while busy | Yes | Shortlist and Remove ask the API…; the API's refusal is shown as it is; a request with a supplier chosen keeps its shortlist fixed…; a viewer can read everything but not shortlist | ✅ |


Posts panel (ARB-202, `apps/web/src/sourcing-posts.js`). The API is an in-memory copy of
`apps/api/src/routes/sourcing-posts.ts` (tested against real Postgres in
`routes/sourcing-posts.test.ts`): `GET`/`POST /v1/sourcing-requests/:id/posts`,
`PATCH /v1/sourcing-posts/:id`, `POST …/approve`, `…/posted`, `…/close`.

| Control | Label text | Expected action | Actual action | Loading state | Success state | Error state | Disabled state rule | Keyboard reachable | Playwright test name | Pass |
|---|---|---|---|---|---|---|---|---|---|---|
| Select | Platform | Choose Freelancer.com, Upwork (by hand) or Fiverr (by hand) | Sent with Draft a post | — | — | — | Never | Yes | Draft a post writes the brief’s scope… | ✅ |
| Button (submit) | Draft a post | Draft a post from the brief's scope for that platform | `POST /v1/sourcing-requests/:id/posts` with `{ platform }`; the panel re-read | Spinner, aria-busy, disabled | "Drafted the <platform> post from the brief’s scope. Read it, edit it, then approve it." | The API's refusal as it is (one live post per platform; a request no longer open) | When the request is no longer open; for a viewer (title says which); while busy | Yes | Draft a post writes the brief’s scope for the chosen platform, with no budget; a viewer can read the posts but not… | ✅ |
| Button (per post) | Edit (aria-label "Edit the <platform> post") | Open the post's form | Form shown with the title, text and budget | — | — | — | Once posted or closed; for a viewer (title says which) | Yes | an edit that names the client is refused…; Save post sends the budget… | ✅ |
| Inputs ×5 (per post) | Post title, Post text, Budget currency, Budget from, Budget to | The post's words and the budget suppliers see | Amounts read as text into whole cents (`parseAmountText`); checked with `validateSourcingPostEdit` and `clientIdentifyingProblems`, the API's own rules | — | — | Each problem on its field ("Contains the client’s handle.", "Contains an email address.", "Must be an amount such as 8000.00.") | — | Yes | an edit that names the client is refused on the page, and nothing is sent; Save post sends the budget as whole cents… | ✅ |
| Button (submit, per post) | Save post (aria-label "Save the <platform> post") | Save the words and the budget; clear any approval | `PATCH /v1/sourcing-posts/:id`; the panel re-read | Spinner, aria-busy, disabled | "Saved the <platform> post." / "…Its approval is cleared; approve it again when it is right." | The API's identity check on the fields with "The post could identify the client. Take out what is named and save again." | While busy | Yes | Save post sends the budget as whole cents and shows it in the one money format; the API’s identity check lands on the fields with its own sentence | ✅ |
| Button (per post) | Cancel (aria-label "Cancel editing the <platform> post") | Leave the post as it was | Form hidden; nothing sent | — | — | — | Never | Yes | Cancel leaves the post as it was | ✅ |
| Button (per post) | Approve (aria-label "Approve the <platform> post") | Approve the words in the person's name, after a confirmation | Dialog → `POST …/approve` (the API checks the words once more) | Spinner, aria-busy, disabled | "Approved the <platform> post." (a Freelancer.com post adds that it is posted when live mode allows); "approved by <name> via web" on the card | The API's refusal as it is | Unless the post is a draft; a Freelancer.com post without a budget; for a viewer (title says which) | Yes (Cancel has focus) | Approve asks first, then approves in the person’s name; it cannot be approved twice; a Freelancer.com post without a budget cannot be approved, and says why | ✅ |
| Button (Upwork and Fiverr posts) | Record as posted (aria-label "Record the <platform> post as posted by hand") | Record that a person posted the approved words on the platform | `POST …/posted`; "posted <date> by hand" on the card | Spinner, aria-busy, disabled | "Recorded the <platform> post as posted by hand." | The API's refusal as it is | Until approved; once posted; for a viewer (title says which). Not shown on a Freelancer.com post | Yes | an Upwork post is recorded as posted by hand only once approved; Draft a post… (no such button on Freelancer.com) | ✅ |
| Button (posted Freelancer.com post) | Collect bids now (aria-label "Collect the bids on the Freelancer.com post now") | Ask for the project's bids to be read now, rather than at the next half-hourly read | `POST …/collect` (202); the bids arrive as candidates in the ranking table, marked as bids with their country | Spinner, aria-busy, disabled | "Asked Freelancer.com for the bids on the Freelancer.com post. They appear in the ranking as they arrive." | The API's refusal as it is (503 while the workers are not running, B-12) | Shown only on a posted Freelancer.com post; for a viewer (title says so); while busy | Yes | a failed post shows why; a posted one shows its project and collects its bids on request; a bid collected from the platform appears in the ranking… | ✅ |
| Button (per post) | Close (aria-label "Close the <platform> post") | Close the post, after a confirmation | Dialog (danger) → `POST …/close` | Spinner, aria-busy, disabled | "Closed the <platform> post." | The API's refusal as it is | Once closed; for a viewer (title says which) | Yes (Cancel has focus) | Close asks first and closes the post | ✅ |

Figures (docs/05 section 3): each rate is `formatMoney` of the rate card's stored minor
units, fixed or an hour as the brief is priced; the score is the stored total out of 100
with its five stored parts; every reason is the sentence stored with the candidate when it
was ranked. The Margin cell is the evaluation the reprice worker stored for the
candidate's latest priced quote: `formatMoney` of its margin and `formatPercent` of its
stored percentage, with "Clears the margin rule." or "Below the margin rule."; while a rule
is unanswered it says "Not priced" and names the rules (docs/02 D-02, D-03, T-02), with no
figure. Nothing is recalculated on the page. The weights are named constants in
`@arbitron/core` (rate 40, turnaround 20, quality 20, time zone 10, payment after delivery
10) and every score is hand-worked in a test.

Shortlisting sends nothing and can be undone. Approving a post and closing one ask
first (docs/05 section 1.3 names posting a project); nothing on this page posts to a
marketplace. Freelancer.com posting is ARB-203, behind the approval and the live gate;
Upwork and Fiverr posts are made by a person and only recorded here.

Page-level: no session → login with `next`; 401 → login; no horizontal scroll at 380 px;
`?request=` restores the view. Rule 6 (keyboard, re-walked for ARB-210): a request is
opened with Enter, the candidate row's controls are reached in reading order (Reprice in
the Margin column, then Shortlist) and work with Enter, and the posts panel's Platform
select has its label attached — "a request is opened and a candidate repriced and
shortlisted from the keyboard, in reading order". Sourcing posts also wait on the
approvals page (docs/audit/approvals.md, D-057).
