/**
 * Prints the seed as SQL (ARB-013), for `pnpm db:seed` to pipe into psql. The SQL is
 * `buildSeedSql()`, the same script `seed.test.ts` applies twice against real Postgres
 * to prove it idempotent.
 */
import { buildSeedSql } from '../src/seed.js';

process.stdout.write(buildSeedSql());
