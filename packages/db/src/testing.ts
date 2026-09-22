import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from './migrations.js';

/**
 * What a real Supabase project supplies and PGlite does not: the `auth` schema, the
 * `auth.uid()` the policies are written against, and the three roles PostgREST switches
 * into when it serves a request. The definitions mirror Supabase's own, so the policies
 * under test are the same ones that will run in production.
 *
 * This shim is test scaffolding and is never applied to a real database. pgsodium is
 * still absent (docs/BLOCKERS.md V-02), so token encryption stays unexercised until the
 * Supabase project exists.
 */
export const SUPABASE_SHIM_SQL = `
create role anon nologin;
create role authenticated nologin;
-- service_role bypasses RLS in Supabase; workers use it deliberately.
create role service_role nologin bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create or replace function auth.uid() returns uuid
language sql
stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

-- Supabase's identity table, reduced to the columns this schema reads. The triggers in
-- 0009 hang off it, so it has to exist before the migrations run.
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);
`;

/** A fresh in-memory Postgres with the shim and every migration applied. */
export async function createTestDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM_SQL);
  for (const migration of loadMigrations()) {
    try {
      await db.exec(migration.sql);
    } catch (error) {
      throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`);
    }
  }
  return db;
}

/**
 * Act as a signed-in user, exactly as PostgREST does: put the JWT claims in the
 * session and switch to the `authenticated` role. Everything after this call is
 * subject to row level security.
 */
export async function signIn(db: PGlite, authUserId: string): Promise<void> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: authUserId }),
  ]);
  await db.exec('set role authenticated');
}

/** Signed in as nobody: the `authenticated` role with no claims, which is what a
 * stolen-but-empty session looks like. */
export async function signInAsNobody(db: PGlite): Promise<void> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role authenticated');
}

/** Back to the migration-running superuser, for seeding and assertions. */
export async function signOut(db: PGlite): Promise<void> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
}
