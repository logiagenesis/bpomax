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
 *   ARB-131  brief schema
 */
export * from './allowance.js';
export * from './auth.js';
export * from './drafting.js';
export * from './estimating.js';
export * from './events.js';
export * from './margin.js';
export * from './money.js';
export * from './privacy.js';
export * from './scanners.js';
export * from './scoring.js';
export * from './settings.js';
export * from './submitting.js';
export const PACKAGE_NAME = '@arbitron/core';
