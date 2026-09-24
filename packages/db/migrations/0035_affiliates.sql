-- 0035 ARB-430: affiliates and attribution, from the click to a paid subscription.
--
-- The programme is the house org's (D-069): its owner creates the affiliates (0008 lets
-- an owner write `affiliates` for their own org). A click is an `attribution` row with
-- no org yet, written by the API for an anonymous visitor; `app.create_org` attaches it
-- to the org made in that browser; the org's first paid plan marks it converted
-- (ARB-420's `activatePlan`). A click stores the code, the page and the time: no address,
-- no browser details, nothing that identifies the visitor.
alter table affiliates add constraint affiliates_code_format
  check (code ~ '^[A-Za-z0-9-]{3,40}$');

alter table attribution
  add column landing_page text check (landing_page is null or landing_page ~ '^[a-z-]+\.html$'),
  add column signed_up_at timestamptz;
create index attribution_affiliate_idx on attribution (affiliate_id);
create index attribution_org_idx on attribution (org_id) where org_id is not null;

-- ARB-400's create_org, now also taking the click the browser kept (D-071). Only a
-- click not yet attached to an org is taken, so a click id cannot move an org that
-- already exists or be used twice.
drop function app.create_org(text, text, text);

create function app.create_org(
  p_name text,
  p_country_code text default 'ZA',
  p_request_id text default null,
  p_referral uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_org uuid;
  v_affiliate uuid;
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

  insert into public.orgs (name, country_code) values (v_name, v_country)
  returning id into v_org;

  insert into public.memberships (org_id, user_id, role) values (v_org, v_user, 'owner');

  insert into public.settings (org_id) values (v_org);

  insert into public.events (
    org_id, actor_user_id, actor_kind, type, subject_table, subject_id, request_id,
    outcome, payload
  ) values (
    v_org, v_user, 'user', 'org.created', 'orgs', v_org, p_request_id, 'ok',
    jsonb_build_object('name', v_name, 'countryCode', v_country)
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

revoke all on function app.create_org(text, text, text, uuid) from public;
grant execute on function app.create_org(text, text, text, uuid) to authenticated, service_role;
