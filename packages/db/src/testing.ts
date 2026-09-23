import { PGlite } from '@electric-sql/pglite';
import { loadMigrations } from './migrations.js';

/**
 * What a real Supabase project supplies and PGlite does not: the `auth` schema, the
 * `auth.uid()` the policies are written against, the three roles PostgREST switches
 * into when it serves a request, and Vault's interface (without its encryption). The definitions mirror Supabase's own, so the policies
 * under test are the same ones that will run in production.
 *
 * This shim is test scaffolding and is never applied to a real database. Token
 * encryption is proven against the real Vault extension in CI's compose job instead
 * (D-041).
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

-- Supabase Vault's interface (https://supabase.com/docs/guides/database/vault): the same
-- table, view and two functions, with the same signatures. It does NOT encrypt: the
-- secret is stored as given. Encryption is the real extension's job, and CI proves it
-- on the supabase/postgres image (scripts/db-verify-vault.sql, D-041).
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, key_id, nonce,
         created_at, updated_at
  from vault.secrets;
create function vault.create_secret(
  new_secret text, new_name text default null, new_description text default '',
  new_key_id uuid default null
) returns uuid language sql as $$
  insert into vault.secrets (secret, name, description, key_id)
  values (new_secret, new_name, coalesce(new_description, ''), new_key_id)
  returning id;
$$;
create function vault.update_secret(
  secret_id uuid, new_secret text default null, new_name text default null,
  new_description text default null, new_key_id uuid default null
) returns void language sql as $$
  update vault.secrets
     set secret = coalesce(new_secret, secret),
         name = coalesce(new_name, name),
         description = coalesce(new_description, description),
         key_id = coalesce(new_key_id, key_id),
         updated_at = now()
   where id = secret_id;
$$;
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
