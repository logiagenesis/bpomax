-- Proves that marketplace tokens are encrypted at rest by the real Supabase Vault
-- extension (ARB-020, docs/BLOCKERS.md V-02, DECISIONS.md D-041). Run by CI's compose
-- job against the supabase/postgres image after `pnpm db:reset`. Everything happens in
-- one transaction that is rolled back, so the database is left as it was.
--
-- The test suites use a Vault shim that does not encrypt; this is the check that the
-- real extension does. Each check raises at the first thing that is wrong.
\set ON_ERROR_STOP on
begin;

insert into orgs (id, name) values ('99999999-0000-4000-8000-000000000001', 'Vault probe');
insert into platform_accounts (id, org_id, platform, external_user_id)
values ('99999999-0000-4000-8000-000000000005', '99999999-0000-4000-8000-000000000001',
        'freelancer', 'vault-probe');

select app.put_platform_tokens('99999999-0000-4000-8000-000000000005',
  'probe-access-token-7f3a', 'probe-refresh-token-9c1d', now() + interval '30 days');

do $$
declare
  v_stored int;
begin
  select count(*) into v_stored from vault.secrets
   where name like 'platform_account:99999999-0000-4000-8000-000000000005:%';
  if v_stored <> 2 then
    raise exception 'expected 2 secrets in vault.secrets, found %', v_stored;
  end if;

  -- 1. What is on disk is not the token.
  if exists (
    select 1 from vault.secrets
     where secret::text like '%probe-access-token%' or secret::text like '%probe-refresh-token%'
  ) then
    raise exception 'a token is stored in vault.secrets as plain text';
  end if;

  -- 2. It decrypts to the token for service_role's function.
  if (select access_token from app.platform_tokens('99999999-0000-4000-8000-000000000005'))
     is distinct from 'probe-access-token-7f3a' then
    raise exception 'the access token did not decrypt to what was stored';
  end if;
  if (select refresh_token from app.platform_tokens('99999999-0000-4000-8000-000000000005'))
     is distinct from 'probe-refresh-token-9c1d' then
    raise exception 'the refresh token did not decrypt to what was stored';
  end if;
  raise notice '2 secrets stored encrypted, and both decrypt: ok';
end;
$$;

-- 3. A signed-in role cannot read it back.
set local role authenticated;
do $$
begin
  perform * from app.platform_tokens('99999999-0000-4000-8000-000000000005');
  raise exception 'the authenticated role read a token';
exception when insufficient_privilege then
  raise notice 'authenticated cannot read tokens: ok';
end;
$$;
reset role;

-- 4. Disconnecting deletes the secrets.
select app.clear_platform_tokens('99999999-0000-4000-8000-000000000005');
do $$
begin
  if exists (
    select 1 from vault.secrets
     where name like 'platform_account:99999999-0000-4000-8000-000000000005:%'
  ) then
    raise exception 'disconnecting left the secrets in vault.secrets';
  end if;
  raise notice 'secrets deleted on disconnect: ok';
end;
$$;

rollback;
\echo 'Vault check passed: tokens encrypted at rest, decrypted only for service_role, deleted on disconnect'
