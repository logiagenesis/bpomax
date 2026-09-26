# Privacy data inventory — for the T-06 legal review

Document: LI-PRIV-ARB-0926 — 23/09/2026 (ARB-015); revised 26/09/2026 (ARB-522, the
owner's audit P-07)

This is a factual list of the personal information the system holds, where it is held,
who receives it and what removes it. It was read from the migrations
(`packages/db/migrations`, 0001 to 0039) and the code that writes and sends each field.
It is written for the owner and the legal adviser answering docs/02 T-06. It is not a
privacy notice, and it gives no legal view. The notice itself is published from
`apps/web/src/public/privacy-notice.json` once approved (DECISIONS.md D-040).

Where a column exists but nothing in the application fills it, the list says so.

## 1. People who use the app (owners, operators, viewers)

| Where | Fields | How it gets there | Kept until |
|---|---|---|---|
| Supabase Auth (`auth.users`, Supabase's own table) | Email, password (held by Supabase), sign-up metadata `terms_version` and `terms_accepted_at` | The sign-up page's `POST /auth/v1/signup` (`apps/web/src/signup.js`); no name is sent | Supabase's own handling; nothing here deletes it |
| `users` | `email`, `auth_user_id`, `telegram_chat_id`; `full_name` exists but nothing in the application fills it | Copied from Supabase Auth by a trigger (0009); the Telegram chat when a link code is used (`apps/telegram/src/engine.ts`) | Not deleted: deleting a person is designed, not built (D-080, docs/BLOCKERS.md D-17). If the Auth identity is deleted, only `auth_user_id` is cleared (0009) |
| `memberships` | Which org, which role | Org creation (`app.create_org`) or an owner | As `users` |
| `orgs` | `name`, `country_code` (a sole trader's org name can be their own name) | Onboarding | As `users` |
| `terms_acceptances` | Who accepted which terms version, when, with the request id | `app.create_org` (0039, D-081) | As `users` |
| `platform_accounts` | The marketplace account's `external_user_id` and `external_username` (Freelancer.com: the operator's username; Upwork: the account's `name`), `plan_name`, token secret ids | Connecting an account | Tokens: deleted from Vault on disconnect (0017). The row and its identifiers: not deleted |
| `platform_connect_attempts`, `telegram_link_codes` | Who started a connect or a Telegram link, and when | The connect and link flows (ten-minute codes) | Marked used; never deleted |
| `telegram_pending` | The chat id, the action and the bid it is about; no text | A Telegram button press | Removed when the next chat message uses it, or replaced by the next press |
| "Who did it" columns | `approved_by` (proposals, messages, sourcing posts, auto-replies), `recorded_by` (payments), `created_by` (billing checkouts) | The person approving, recording or paying | With the row |
| `events` (the audit log) | `actor_user_id` on every recorded action; see section 4 for payloads | Written by the system | Append-only: never updated or deleted (0007) |
| `affiliates` | `owner_email`, `code`, `commission_pct` | The house owner, on the affiliates page | Not deleted |

**Tokens.** Marketplace OAuth tokens are held in Supabase Vault (`vault.create_secret`,
migration 0017, D-041), not pgsodium as the first version of this list said. Only the
service role can read them back. Test databases use a stand-in with no encryption; CI
proves the real Vault extension (D-041).

## 2. Marketplace clients

| Where | Fields | How it gets there | Kept until |
|---|---|---|---|
| `jobs` | `title`, `description`, `raw` (the platform's listing exactly as returned, no field removed); `client_payment_verified`, `client_spend_minor` (Upwork only). `client_country` and `client_rating` exist but nothing fills them; Upwork's client country is inside `raw` | Freelancer.com project search (asks for `full_description` and `job_details`); Upwork job search (asks for the client's spend, verification, hires, feedback and country) | Upwork: deleted 24 hours after it was fetched, with everything derived from it (D-066). Freelancer.com: not deleted |
| `threads` | `client_handle`: the other member's Freelancer.com username or display name, else their user id | Inbox sync (`apps/workers/src/inbox-sync.ts`) | Redacted by retention or erasure (section 6) |
| `messages` | `body`: the client's messages and ours. `failure_reason`: can hold an operator's typed rejection reason | Inbox sync; drafts and approvals | `body` redacted by retention or erasure; `failure_reason` is not |
| `discovery_sessions` | `answers`: the client's answers | Discovery (ARB-130) | Emptied by retention or erasure |
| `briefs` | Every text field (title, outcome, users, must-haves, references, assets, constraints, acceptance criteria, risks, budget, deadline), `sign_off_name` (the client's sign-off person), `sign_off_response_time` | Brief builder, from the answers (ARB-131) | Not redacted (question 2) |
| `proposals` | `body` (the bid), `milestones`, `operator_notes` (the model's notes on the bid, up to 500 characters), `failure_reason` (a rejection reason typed on the page or in Telegram, or a platform error) | Draft-bid worker; approvals | Not redacted |
| `job_scores.reasons`, `margin_evaluations.reason` | Model-written or rule sentences that can restate the job | Score and margin workers | Not redacted |

## 3. Suppliers, bidders and others

| Where | Fields | How it gets there | Kept until |
|---|---|---|---|
| `suppliers`, `supplier_rate_cards` | `name`, `country_code`, `time_zone`, `languages`, `external_profile_url`, `notes`, quality and on-time scores, prices | Entered or imported by the owner (ARB-200) | Not deleted |
| `supplier_candidates` | `display_name` (a Freelancer.com bidder's username), `country_code` (the bidder's country), `external_profile_url`, the quoted price | Bids on our sourcing posts (ARB-203) | Not deleted |
| `sourcing_requests.excluded` | Each supplier left out: id, name, reason | The sourcing worker | Not deleted |
| `sourcing_posts` | `title`, `body` (scope only, never client-identifying, by design: 0004) | The sourcing worker, approved by a person | Not deleted |
| `portfolio_items` | `title`, `url`, `description` | The owner | Not deleted |
| `payments` | No payer name or email. Free-text `reference` and `note` | Recorded by a person | Not deleted |
| `subscriptions`, `billing_checkouts`, `billing_webhook_receipts` | The payment provider's customer, subscription and session ids; no email; the webhook body is not stored (only its event id or a hash, and a short outcome) | Billing (ARB-420) | Not deleted |
| `attribution` | A referral click: which affiliate, the landing page, when; no IP address, no browser details | The referral link (ARB-430) | Not deleted |

## 4. The audit log (`events.payload`)

Client text is kept out of the audit log: bid text, milestone titles, operator notes,
rejection reasons and every would-send message are stored as a fingerprint (length and
SHA-256), never the words (D-076, `textFingerprint` in `packages/db/src/events.ts`).
Edits record the new length only. No payload holds an email address. `privacy.exported`
and `privacy.erased` hold counts only, never the handle (D-080).

Payloads that do hold names or free text:

- the org's name and country (`org.created`);
- the operator's own Freelancer.com username (`account.connected`);
- the org's own auto-reply wording, before and after a change (`settings.changed`);
- milestone titles (`delivery.milestone_changed`), template names and labels, scanner
  and plan names;
- a bidder's country and price, not their name (`supplier.candidate_added`);
- error messages from the platforms and the model, as returned.

## 5. Outside the database

- **Redis (the job queues).** Job data holds ids only: no message, bid text or email
  (`apps/workers/src`, each queue's payload). The one exception is the Telegram usage
  alert, which carries the owner's chat id and a line of text naming the org, the plan
  and the counts. Kept: the last 1 000 completed and 5 000 failed jobs per queue.
  Completed scoring jobs keep their result, which includes the model's reasons. Dead
  letters keep a failed job's data and error until removed by hand
  (`apps/workers/src/queues.ts`).
- **Logs.** The API and the bot log the method, path and request id of each request,
  not bodies.

## 6. Who receives it

| Recipient | What it receives | Why |
|---|---|---|
| Anthropic (the model, `@anthropic-ai/sdk`) | Job titles, descriptions, skills, budget and the client's country, spend, verification and rating (scoring, classifying, drafting); the template and portfolio text (drafting); **a client's message word for word** (discovery); the discovery answers (brief). No client handle is sent in any prompt. Not yet exercised against the real service | Scoring, estimating, drafting, discovery, briefs |
| Freelancer.com | The bid text; our messages to a client; sourcing project titles and descriptions | Bidding, messaging, sourcing |
| Upwork | Search filters only; nothing about a person | Read-only job search |
| Telegram (Bot API) | Bid cards with the first 400 characters of the bid; **new-message cards with the client's handle and the first 400 characters of their message**, to the org's owners and operators; reprice cards with a bidder's display name; the operator's name on linking; usage alerts with the org and plan name; a typed rejection reason echoed back | Approvals and alerts in the operator's chat |
| Paystack | The owner's email, the amount, the plan and our reference | Card payment in rand |
| Stripe | The owner's email, the price, our reference | Card payment in US dollars |
| Supabase | Everything in sections 1 to 4 (it hosts the database and Vault); sign-up and sign-in details | Hosting and sign-in |
| Vercel | Nothing personal: it serves the web pages only | Hosting the web app |
| The operator's MCP client | A conversation's messages and the client's handle, through `get_thread` | The operator's own assistant (ARB-330) |
| Email | No provider is set up (`packages/email`); Supabase sends its own confirmation email | — |

No analytics or error-tracking service is present.

## 7. What removes it today

- **Retention** (`purgeAll`, `packages/db/src/retention.ts`, daily at 00:00 UTC, which is
  02:00 SAST, D-040). For each organisation it reads `settings.retention_days`.
  - **No period set.** It changes nothing and records `retention.purged` with outcome
    `skipped`, naming T-06. Live mode cannot be switched on in this state (migration 0010).
  - **A period set: closing idle threads.** A thread with no message for the whole period
    is closed, unless its job was won or is in delivery (D-076).
  - **A period set: redacting closed threads.** For every thread closed and quiet past the
    period, it clears `client_handle`, replaces each `messages.body` with
    `[redacted: retention period elapsed]` and empties `discovery_sessions.answers`.
  - **What stays.** Rows are kept, so the pipeline, payments and audit log stay whole.
    Each run is recorded with its counts. A new message from the client reopens the
    thread for the new words only.
- **Upwork jobs:** deleted 24 hours after fetching, with their scores, estimates,
  margins, bids and pipeline items, on every ingest run (D-066).
- **A client's erasure on request** (D-080). An owner, in settings, redacts one client's
  conversations in their organisation by handle: the handle, the words and the answers.
- **A person's own data** (D-080). "Download my data" in settings gives a person every
  row naming them.
- **Disconnecting a marketplace account:** deletes its tokens from Vault.

**Not removed by anything today:**

- in conversations: `messages.failure_reason`, `briefs`;
- in bids: `proposals` (body, notes, reasons);
- about jobs: Freelancer.com `jobs` (title, description, `raw`), `job_scores.reasons`;
- about suppliers: supplier, candidate and sourcing rows;
- records: `llm_calls` (no text), used link codes and connect attempts, billing receipts,
  the audit log;
- in Redis: dead letters.

Deleting a person or an organisation waits on D-17.

## 8. Questions for the adviser

These are open. The code does not answer them.

1. The retention period in days (`settings.retention_days`, 1 to 3650).
2. Should briefs (`briefs`) and the other conversation-derived fields above be redacted
   with their thread? Today they are not.
3. Should Freelancer.com jobs (`jobs.title`, `description`, `raw`) be redacted or
   deleted after a period, for jobs never bid on? Today they are not; Upwork's are,
   after 24 hours.
4. Is redaction, rather than deletion, acceptable for conversations? It keeps the
   audit log complete.
5. How long should the audit log (`events`), billing records and supplier records be
   kept?
6. For a person who asks to be erased, or an organisation that leaves: is the audit log
   deleted, kept for a period, or kept with the person's details removed (D-17, the
   three designs in D-080)?
7. Sending a client's message to the model for discovery, and a preview of it to the
   operator's Telegram: does the notice need to say so, and to whom?
8. The wording of the privacy notice, and where it must be shown to marketplace clients.
