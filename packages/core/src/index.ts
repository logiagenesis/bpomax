/**
 * @arbitron/core — domain logic shared by every app.
 *
 * Contents arrive ticket by ticket (see docs/04-PROJECT-BOARD.md):
 *   ARB-012  roles and what each may do          (auth.ts)
 *   ARB-013  service category taxonomy
 *   ARB-014  audit log vocabulary                 (events.ts)
 *   ARB-015  privacy notice shape                  (privacy.ts)
 *   ARB-021  scanner validation                    (scanners.ts)
 *   ARB-032  job scoring schema and red-flag rules (scoring.ts)
 *   ARB-040  estimate method order and classification (estimating.ts)
 *   ARB-041  margin engine                          (margin.ts)
 *   ARB-042  bid allowance                          (allowance.ts)
 *   ARB-043  draft rules: price, timeline, milestones, citations (drafting.ts)
 *   ARB-044  submission rules: approval, live gate, payload (submitting.ts)
 *   ARB-061  settings, plan and approval form rules      (settings.ts)
 *   ARB-121  auto-reply rule and the offline test       (auto-reply.ts)
 *   ARB-122  outbound message draft rule and state       (messaging.ts)
 *   ARB-130  discovery question set, batches, completeness (discovery.ts)
 *   ARB-131  brief schema, lock rule, drafts        (brief.ts)
 *   ARB-200  supplier CSV template, parser, validator and export (suppliers.ts)
 *   ARB-201  supplier ranking for a locked brief          (sourcing.ts)
 *   ARB-202  sourcing post drafts and the client-identity check (sourcing-posts.ts)
 *   ARB-310  delivery orders: milestones reconciled, handover checklist, moves (delivery.ts)
 *   ARB-311  payments, their rand figures and realised margin      (payments.ts)
 *   ARB-320  analytics: rates and margin per category, template, supplier, scanner (analytics.ts)
 *   ARB-400  sign-up: the new-org rule, onboarding steps, the terms shape (orgs.ts, terms.ts)
 *   ARB-410  plans, metered actions, usage checks and the 80 %/100 % alerts (plans.ts)
 */
export * from './allowance.js';
export * from './analytics.js';
export * from './auth.js';
export * from './auto-reply.js';
export * from './brief.js';
export * from './delivery.js';
export * from './discovery.js';
export * from './drafting.js';
export * from './estimating.js';
export * from './events.js';
export * from './margin.js';
export * from './messaging.js';
export * from './money.js';
export * from './orgs.js';
export * from './payments.js';
export * from './plans.js';
export * from './privacy.js';
export * from './scanners.js';
export * from './scoring.js';
export * from './settings.js';
export * from './sourcing.js';
export * from './sourcing-posts.js';
export * from './submitting.js';
export * from './suppliers.js';
export * from './templates.js';
export * from './terms.js';
export const PACKAGE_NAME = '@arbitron/core';
