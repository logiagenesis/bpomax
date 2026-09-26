-- 0039 terms of service acceptance, enforced where the org is made, from the owner's
-- audit LI-AUDIT-BPOMAX-TASKS-20260925 P-08 (ARB-522)
--
-- Sign-up asked a new person to accept the terms (D-068), but `app.create_org` did not
-- check it: anyone signed in could make an org with a call that never mentioned them.
-- Now the published versions are recorded here, and `create_org` makes an org only for
-- a person who names the current version, recording that they accepted it.
--
-- The wording is the owner's (apps/web/src/public/terms.json, docs/BLOCKERS.md D-16);
-- this table holds only which versions were published and when they were approved. The
-- API records the version on show when it starts (apps/api/src/terms.ts).

create table public.terms_versions (
  version text primary key check (length(version) between 1 and 40),
  approved_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger terms_versions_updated_at before update on public.terms_versions
  for each row execute function set_updated_at();

alter table public.terms_versions enable row level security;
create policy terms_versions_select_all on public.terms_versions
  for select to authenticated using (true);
revoke insert, update, delete on public.terms_versions from authenticated, anon;
grant select on public.terms_versions to authenticated;
grant all on public.terms_versions to service_role;

create table public.terms_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  version text not null references public.terms_versions (version),
  request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, version)
);
create trigger terms_acceptances_updated_at before update on public.terms_acceptances
  for each row execute function set_updated_at();

-- A person sees their own acceptances; only `create_org` (security definer) and the
-- service role write them.
alter table public.terms_acceptances enable row level security;
create policy terms_acceptances_select_own on public.terms_acceptances
  for select to authenticated using (user_id = app.current_user_id());
revoke insert, update, delete on public.terms_acceptances from authenticated, anon;
grant select on public.terms_acceptances to authenticated;
grant all on public.terms_acceptances to service_role;

-- 0035's create_org, now also taking the version of the terms the person accepted.
drop function app.create_org(text, text, text, uuid);

create function app.create_org(
  p_name text,
  p_country_code text default 'ZA',
  p_request_id text default null,
  p_referral uuid default null,
  p_terms_version text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_org uuid;
  v_affiliate uuid;
  v_terms text;
  v_name text := trim(coalesce(p_name, ''));
  v_country text := upper(trim(coalesce(p_country_code, '')));
begin
  if auth.uid() is null then
    raise exception 'sign in first: nobody is signed in'
      using errcode = 'insufficient_privilege';
  end if;

  select id into v_user from public.users where auth_user_id = auth.uid() for update;
  if v_user is null then
    raise exception 'sign in first: this identity has no application user yet'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (select 1 from public.memberships where user_id = v_user) then
    raise exception 'you are already a member of an organisation'
      using errcode = 'unique_violation';
  end if;

  if length(v_name) = 0 or length(v_name) > 100 then
    raise exception 'the organisation name must be 1 to 100 characters'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_country !~ '^[A-Z]{2}$' then
    raise exception 'the country must be a two-letter ISO 3166-1 code'
      using errcode = 'invalid_parameter_value';
  end if;

  select version into v_terms from public.terms_versions
   order by approved_on desc, created_at desc limit 1;
  if v_terms is null then
    raise exception 'the terms of service are not published yet, so no organisation can be made'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if p_terms_version is distinct from v_terms then
    raise exception 'accept the current terms of service first'
      using errcode = 'check_violation';
  end if;

  insert into public.orgs (name, country_code) values (v_name, v_country)
  returning id into v_org;

  insert into public.memberships (org_id, user_id, role) values (v_org, v_user, 'owner');

  insert into public.settings (org_id) values (v_org);

  insert into public.terms_acceptances (user_id, version, request_id)
  values (v_user, v_terms, p_request_id)
  on conflict (user_id, version) do nothing;

  insert into public.events (
    org_id, actor_user_id, actor_kind, type, subject_table, subject_id, request_id,
    outcome, payload
  ) values (
    v_org, v_user, 'user', 'org.created', 'orgs', v_org, p_request_id, 'ok',
    jsonb_build_object('name', v_name, 'countryCode', v_country, 'termsVersion', v_terms)
  );

  if p_referral is not null then
    update public.attribution
       set org_id = v_org, signed_up_at = now()
     where id = p_referral and org_id is null and affiliate_id is not null
    returning affiliate_id into v_affiliate;
    if v_affiliate is not null then
      insert into public.events (
        org_id, actor_user_id, actor_kind, type, subject_table, subject_id, request_id,
        outcome, payload
      ) values (
        v_org, v_user, 'user', 'affiliate.attributed', 'attribution', p_referral,
        p_request_id, 'ok', jsonb_build_object('affiliateId', v_affiliate)
      );
    end if;
  end if;

  return v_org;
end;
$$;

revoke all on function app.create_org(text, text, text, uuid, text) from public;
grant execute on function app.create_org(text, text, text, uuid, text)
  to authenticated, service_role;
