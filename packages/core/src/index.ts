/**
 * @arbitron/core — domain logic shared by every app.
 *
 * Contents arrive ticket by ticket (see docs/04-PROJECT-BOARD.md):
 *   ARB-012  roles and what each may do          (auth.ts)
 *   ARB-013  service category taxonomy
 *   ARB-014  audit log vocabulary                 (events.ts)
 *   ARB-021  scanner validation                    (scanners.ts)
 *   ARB-032  job scoring schema
 *   ARB-041  margin engine
 *   ARB-131  brief schema
 */
export * from './auth.js';
export * from './events.js';
export * from './scanners.js';
export const PACKAGE_NAME = '@arbitron/core';
