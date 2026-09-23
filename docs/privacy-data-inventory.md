# Privacy data inventory — for the T-06 legal review

Document: LI-PRIV-ARB-0926 — 23/09/2026 (ARB-015)

This is a factual list of the personal information the system stores, read from the
migrations in `packages/db/migrations`. It is written for the owner and the legal adviser
answering docs/02 T-06. It is not a privacy notice, and it gives no legal view. The
notice itself is published from `apps/web/src/public/privacy-notice.json` once approved
(DECISIONS.md D-040).

## Who the information is about

| Person | Where it is stored | Fields holding personal information | Source |
|---|---|---|---|
| Operators (owner, operator, viewer) | `users` | `email`, `full_name`, `telegram_chat_id` | Entered when an account is created; the Telegram chat when a link code is used |
| Operators | `events` | `actor_user_id` on every recorded action | Written by the system |
| Marketplace clients | `jobs` | `raw` (the platform's project record as returned), `client_country`, `client_payment_verified`, `client_spend_minor`, `client_rating` | Freelancer.com project search (ARB-022) |
| Marketplace clients | `threads` | `client_handle` | Inbox sync (ARB-120) |
| Marketplace clients | `messages` | `body` (inbound and outbound conversation text) | Inbox sync; approved outbound messages |
| Marketplace clients | `discovery_sessions` | `answers` (the client's answers to the discovery questions) | Discovery (ARB-130) |
| Marketplace clients | `briefs` | Requirements text, `sign_off_name`, `sign_off_response_time` | Brief builder (ARB-131) |
| Suppliers | `suppliers` | `name`, `country_code`, `time_zone`, `languages`, `external_profile_url`, `notes`, quality and on-time scores | Entered or imported by the owner (ARB-200) |
| Supplier candidates | `supplier_candidates` | `display_name`, `country_code`, `external_profile_url`, quoted price | Sourcing posts (ARB-203) |

Also stored, not about a person: marketplace OAuth tokens in `platform_accounts`, which are
encrypted at rest with pgsodium (docs/01 section C). `llm_calls` holds token counts and
costs only; the prompt and the reply are never stored there (migration 0011).

## What the retention job does today

`purgeAll` (`packages/db/src/retention.ts`, D-017) runs daily at 02:00 SAST (D-040). For
each organisation it reads `settings.retention_days`:

- **No period set:** it changes nothing and records `retention.purged` with outcome
  `skipped`, naming T-06. Live mode cannot be switched on in this state (a database
  constraint, migration 0010).
- **A period set:** for every thread that is `closed` and has had no message for longer
  than the period, it clears `threads.client_handle`, replaces each `messages.body`
  with `[redacted: retention period elapsed]`, and empties `discovery_sessions.answers`.
  Rows are kept, so the pipeline, payments and audit log stay whole. Each run is
  recorded in `events` with the counts.

## Questions for the adviser

These are open. The code does not answer them.

1. The retention period in days (`settings.retention_days`, 1 to 3650).
2. Should briefs (`briefs`) be redacted with their thread? Today they are not.
3. Should the client fields in `jobs.raw` and the `jobs` columns above be redacted after
   the period, for jobs never bid on? Today they are not.
4. Is redaction, rather than deletion, acceptable for conversations? It keeps the
   audit log complete.
5. How long should the audit log (`events`) and supplier records be kept?
6. The wording of the privacy notice, and where it must be shown to marketplace clients.
