/**
 * @arbitron/db — Supabase migrations, seed data and generated types.
 *
 * Migrations live in packages/db/migrations and are applied with the Supabase CLI.
 * Generated types land in packages/db/src/types.generated.ts (ARB-010).
 */
export * from './client.js';
export * from './events.js';
export * from './migrations.js';
export * from './retention.js';
export * from './seed.js';

export const PACKAGE_NAME = '@arbitron/db';
