-- 0017 marketplace tokens in Supabase Vault, and single-use connect attempts
-- (ARB-020, docs/01 sections C, D and H; DECISIONS.md D-041)
--
-- docs/01 section C names pgsodium for token encryption. Supabase now marks pgsodium
-- "pending deprecation" and says to use Vault instead
-- (https://supabase.com/docs/guides/database/extensions/pgsodium). Vault is authenticated
-- encryption whose key Supabase keeps outside the database
-- (https://supabase.com/docs/guides/database/vault), which is what the section asks of
-- pgsodium. So each account's tokens are two Vault secrets, and the account row holds
-- only their ids.
--
-- In the test databases (PGlite, plain Postgres) the `vault` schema is a shim with the
-- same functions and no encryption (packages/db/src/testing.ts). CI's compose job proves
-- the real extension on the supabase/postgres image (scripts/db-verify-vault.sql).

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    create extension if not exists supabase_vault;
  end if;
end;
$$;

-- A disconnected account keeps its row (and so its history) but holds no token.
alter type platform_account_status add value if not exists 'disconnected';

alter table platform_accounts
  drop column access_token_encrypted,
  drop column refresh_token_encrypted,
  add column access_token_secret_id uuid,
  add column refresh_token_secret_id uuid,
  -- The marketplace's own name for the account, from its user record, for the page.
  add column external_username text;

comment on column platform_accounts.access_token_secret_id is
  'vault.secrets id of the OAuth access token. Read only through app.platform_tokens, which only service_role may call.';
comment on column platform_accounts.refresh_token_secret_id is
  'vault.secrets id of the OAuth refresh token. Read only through app.platform_tokens.';

-- A connect started by a person: the marketplace sends them back with a code, and the
-- code is only accepted while that same person has an unused attempt under ten minutes
-- old. Freelancer.com documents no `state` parameter on its authorise endpoint
-- (https://developers.freelancer.com/docs/authentication/generating-access-tokens), so
-- this row is what binds the returning code to the person who asked (D-041).
create table platform_connect_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  platform platform not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index platform_connect_attempts_user_idx
  on platform_connect_attempts (user_id, platform, created_at desc);

create trigger platform_connect_attempts_updated_at before update on platform_connect_attempts
  for each row execute function set_updated_at();

alter table platform_connect_attempts enable row level security;

-- Members may see the org's attempts; a person may start, and use, only their own.
create policy platform_connect_attempts_select_member on public.platform_connect_attempts
  for select to authenticated using (app.is_member(org_id));
create policy platform_connect_attempts_insert_own on public.platform_connect_attempts
  for insert to authenticated
  with check (app.can_write(org_id) and user_id = app.current_user_id());
create policy platform_connect_attempts_update_own on public.platform_connect_attempts
  for update to authenticated
  using (app.can_write(org_id) and user_id = app.current_user_id())
  with check (app.can_write(org_id) and user_id = app.current_user_id());
create policy platform_connect_attempts_delete_own on public.platform_connect_attempts
  for delete to authenticated
  using (app.can_write(org_id) and user_id = app.current_user_id());

grant select, insert, update, delete on public.platform_connect_attempts to authenticated;
grant all on public.platform_connect_attempts to service_role;

-- Writes an account's tokens into Vault: a new secret the first time, the same secret
-- updated after that. A null refresh token leaves the stored one as it is. Internal:
-- only service_role and the functions below may call it.
create or replace function app.put_platform_tokens(
  p_account uuid,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_access uuid;
  v_refresh uuid;
begin
  if p_access_token is null or length(p_access_token) = 0 then
    raise exception 'an access token is required';
  end if;
  select access_token_secret_id, refresh_token_secret_id into v_access, v_refresh
    from public.platform_accounts where id = p_account for update;
  if not found then
    raise exception 'no such platform account';
  end if;

  if v_access is null then
    v_access := vault.create_secret(
      p_access_token, 'platform_account:' || p_account || ':access', 'OAuth access token');
  else
    perform vault.update_secret(v_access, p_access_token);
  end if;

  if p_refresh_token is not null then
    if v_refresh is null then
      v_refresh := vault.create_secret(
        p_refresh_token, 'platform_account:' || p_account || ':refresh', 'OAuth refresh token');
    else
      perform vault.update_secret(v_refresh, p_refresh_token);
    end if;
  end if;

  update public.platform_accounts
     set access_token_secret_id = v_access,
         refresh_token_secret_id = v_refresh,
         token_expires_at = p_expires_at,
         status = 'connected'
   where id = p_account;
end;
$$;

-- Deletes an account's secrets and marks it disconnected. Internal, as above.
create or replace function app.clear_platform_tokens(p_account uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  select array_remove(array[access_token_secret_id, refresh_token_secret_id], null)
    into v_ids from public.platform_accounts where id = p_account for update;
  if not found then
    raise exception 'no such platform account';
  end if;
  delete from vault.secrets where id = any (v_ids);
  update public.platform_accounts
     set access_token_secret_id = null,
         refresh_token_secret_id = null,
         token_expires_at = null,
         status = 'disconnected'
   where id = p_account;
end;
$$;

-- The tokens, decrypted, for a worker about to call the marketplace. service_role only:
-- a signed-in person can connect and disconnect an account but never read its tokens.
create or replace function app.platform_tokens(p_account uuid)
returns table (access_token text, refresh_token text, expires_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.decrypted_secret::text, r.decrypted_secret::text, p.token_expires_at
    from public.platform_accounts p
    left join vault.decrypted_secrets a on a.id = p.access_token_secret_id
    left join vault.decrypted_secrets r on r.id = p.refresh_token_secret_id
   where p.id = p_account;
$$;

-- The signed-in path: the same two actions, allowed to an owner or operator of the
-- account's org (0008's can_write), refused to anyone else.
create or replace function app.connect_platform_tokens(
  p_account uuid,
  p_access_token text,
  p_refresh_token text,
  p_expires_at timestamptz
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.platform_accounts where id = p_account;
  if v_org is null or not app.can_write(v_org) then
    raise exception 'refused: your role cannot connect platform accounts in this org';
  end if;
  perform app.put_platform_tokens(p_account, p_access_token, p_refresh_token, p_expires_at);
end;
$$;

create or replace function app.disconnect_platform_account(p_account uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.platform_accounts where id = p_account;
  if v_org is null or not app.can_write(v_org) then
    raise exception 'refused: your role cannot disconnect platform accounts in this org';
  end if;
  perform app.clear_platform_tokens(p_account);
end;
$$;

revoke all on function app.put_platform_tokens(uuid, text, text, timestamptz) from public;
revoke all on function app.clear_platform_tokens(uuid) from public;
revoke all on function app.platform_tokens(uuid) from public;
revoke all on function app.connect_platform_tokens(uuid, text, text, timestamptz) from public;
revoke all on function app.disconnect_platform_account(uuid) from public;

grant execute on function app.put_platform_tokens(uuid, text, text, timestamptz) to service_role;
grant execute on function app.clear_platform_tokens(uuid) to service_role;
grant execute on function app.platform_tokens(uuid) to service_role;
grant execute on function app.connect_platform_tokens(uuid, text, text, timestamptz)
  to authenticated, service_role;
grant execute on function app.disconnect_platform_account(uuid) to authenticated, service_role;
