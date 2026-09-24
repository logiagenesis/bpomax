-- 0032 ARB-400: a person who has just signed up creates their own organisation.
--
-- 0008 grants no insert on `orgs` to anyone signed in ("creating an org is service_role
-- work"), and a membership can only be added by an owner of the org. A new person is
-- neither, so creating the first org goes through this one function instead. It runs as
-- its owner (SECURITY DEFINER) and does exactly one thing: for the person making the
-- request, and only for them, it creates an org with them as its owner, the org's empty
-- settings row, and an `org.created` event. It takes no org id and no user id, so it
-- cannot be used to join, or to put someone else into, an org that already exists.
--
-- One self-service org per person (D-067): someone already in any org, as owner,
-- operator or viewer, is refused. Being added to another org stays an owner's act (D-13).
-- The org's base currency stays the column default, ZAR, because the margin rules and
-- the reports are in rand (settings.min_margin_zar_minor, docs/01 section G).

create or replace function app.create_org(
  p_name text,
  p_country_code text default 'ZA',
  p_request_id text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_org uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_country text := upper(trim(coalesce(p_country_code, '')));
begin
  if auth.uid() is null then
    raise exception 'sign in first: nobody is signed in'
      using errcode = 'insufficient_privilege';
  end if;

  -- The row 0009's trigger made when the identity was created. Locked, so two requests
  -- from the same person at once cannot both find no membership and make two orgs.
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

  insert into public.orgs (name, country_code) values (v_name, v_country)
  returning id into v_org;

  insert into public.memberships (org_id, user_id, role) values (v_org, v_user, 'owner');

  -- Every margin rule null, live mode off: the owner supplies them (D-02, D-03, T-02).
  insert into public.settings (org_id) values (v_org);

  insert into public.events (
    org_id, actor_user_id, actor_kind, type, subject_table, subject_id, request_id,
    outcome, payload
  ) values (
    v_org, v_user, 'user', 'org.created', 'orgs', v_org, p_request_id, 'ok',
    jsonb_build_object('name', v_name, 'countryCode', v_country)
  );

  return v_org;
end;
$$;

revoke all on function app.create_org(text, text, text) from public;
grant execute on function app.create_org(text, text, text) to authenticated, service_role;
