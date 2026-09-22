-- 0008 row level security (ARB-011, docs/01 section D and H)
--
-- Every table is tenant-scoped or global reference data. The rule is the same
-- everywhere: a signed-in user reaches a row only through a membership of that row's
-- org. Nothing here trusts the application to pass the right org_id — the database
-- decides, so a bug in a worker or a hand-written query cannot cross a tenant boundary.
--
-- Roles are Supabase's: `anon` (not signed in) gets no table access at all, and
-- `authenticated` gets what the policies below allow. `service_role` bypasses RLS by
-- design; workers that must read another org's row use it deliberately.
--
-- Helpers live in schema `app`, not `public`, so PostgREST does not expose them as RPC.
-- They are SECURITY DEFINER because the policy on `memberships` has to read
-- `memberships`; without it, the policy would recurse into itself.

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- The users row for whoever is making this request, or null when nobody is.
create or replace function app.current_user_id() returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id from public.users u where u.auth_user_id = auth.uid();
$$;

-- True when the caller belongs to this org in any role. Null org_id is never a match,
-- which is what keeps platform-level rows (events with no org, unassigned affiliates)
-- out of every tenant's reach.
create or replace function app.is_member(p_org uuid) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships m
    join public.users u on u.id = m.user_id
    where m.org_id = p_org
      and u.auth_user_id = auth.uid()
  );
$$;

create or replace function app.has_role(p_org uuid, p_roles public.user_role[]) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships m
    join public.users u on u.id = m.user_id
    where m.org_id = p_org
      and u.auth_user_id = auth.uid()
      and m.role = any (p_roles)
  );
$$;

-- Viewers read; they never write. This is half of the ARB-012 acceptance
-- ("viewer cannot approve") and it is enforced here rather than in the API.
create or replace function app.can_write(p_org uuid) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.has_role(p_org, array['owner', 'operator']::public.user_role[]);
$$;

create or replace function app.is_owner(p_org uuid) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.has_role(p_org, array['owner']::public.user_role[]);
$$;

-- Another person is visible only if you already share an org with them.
create or replace function app.shares_org(p_user uuid) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.users u on u.id = mine.user_id
    join public.memberships theirs on theirs.org_id = mine.org_id
    where u.auth_user_id = auth.uid()
      and theirs.user_id = p_user
  );
$$;

-- Grants. RLS narrows what a role can reach; it cannot widen it, so `anon` is given
-- nothing and stays with nothing.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- Global reference data is readable by anyone signed in and writable by no one but
-- service_role: the taxonomy and the price bands are maintained by seeds (ARB-013).
revoke insert, update, delete on public.service_categories from authenticated;
revoke insert, update, delete on public.market_price_bands from authenticated;

do $$
declare
  t text;
begin
  foreach t in array array[
    'orgs', 'users', 'memberships', 'service_categories', 'market_price_bands',
    'platform_accounts', 'scanners', 'jobs', 'job_scores', 'threads', 'messages',
    'discovery_sessions', 'briefs', 'suppliers', 'supplier_rate_cards',
    'sourcing_requests', 'sourcing_posts', 'supplier_candidates', 'delivery_estimates',
    'margin_evaluations', 'proposals', 'pipeline_items', 'delivery_orders', 'payments',
    'templates', 'template_variants', 'auto_replies', 'auto_reply_sends',
    'events', 'settings', 'subscriptions', 'usage_counters', 'affiliates', 'attribution'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- Tenant tables where an operator may write. Read for any member of the org.
do $$
declare
  t text;
begin
  foreach t in array array[
    'platform_accounts', 'scanners', 'jobs', 'job_scores', 'threads', 'messages',
    'discovery_sessions', 'briefs', 'suppliers', 'supplier_rate_cards',
    'sourcing_requests', 'sourcing_posts', 'supplier_candidates', 'delivery_estimates',
    'margin_evaluations', 'proposals', 'pipeline_items', 'delivery_orders', 'payments',
    'templates', 'template_variants', 'auto_replies', 'auto_reply_sends'
  ]
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_member(org_id))',
      t || '_select_member', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (app.can_write(org_id))',
      t || '_insert_operator', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (app.can_write(org_id)) with check (app.can_write(org_id))',
      t || '_update_operator', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (app.can_write(org_id))',
      t || '_delete_operator', t);
  end loop;
end;
$$;

-- Tenant tables only an owner may write: billing, limits, attribution and the
-- settings that govern margin and live mode (ARB-012 acceptance).
do $$
declare
  t text;
begin
  foreach t in array array['settings', 'subscriptions', 'usage_counters', 'affiliates', 'attribution']
  loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_member(org_id))',
      t || '_select_member', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (app.is_owner(org_id))',
      t || '_insert_owner', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (app.is_owner(org_id)) with check (app.is_owner(org_id))',
      t || '_update_owner', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (app.is_owner(org_id))',
      t || '_delete_owner', t);
  end loop;
end;
$$;

-- orgs: visible to its members, renamed only by an owner. Creating and deleting an org
-- is service_role work (ARB-400), so no policy grants it here.
create policy orgs_select_member on public.orgs
  for select to authenticated using (app.is_member(id));
create policy orgs_update_owner on public.orgs
  for update to authenticated using (app.is_owner(id)) with check (app.is_owner(id));

-- users: yourself, plus anyone you share an org with. You may edit only your own row;
-- rows are created by the auth trigger and removed by service_role.
create policy users_select_self_or_colleague on public.users
  for select to authenticated using (id = app.current_user_id() or app.shares_org(id));
create policy users_update_self on public.users
  for update to authenticated
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

-- memberships: every member sees who else is in the org; only an owner changes it.
create policy memberships_select_member on public.memberships
  for select to authenticated using (app.is_member(org_id));
create policy memberships_insert_owner on public.memberships
  for insert to authenticated with check (app.is_owner(org_id));
create policy memberships_update_owner on public.memberships
  for update to authenticated using (app.is_owner(org_id)) with check (app.is_owner(org_id));
create policy memberships_delete_owner on public.memberships
  for delete to authenticated using (app.is_owner(org_id));

-- Reference data: readable by anyone signed in, written by seeds under service_role.
create policy service_categories_select_all on public.service_categories
  for select to authenticated using (true);
create policy market_price_bands_select_all on public.market_price_bands
  for select to authenticated using (true);

-- events: the audit log is readable by the org and appended to by its operators.
-- There is deliberately no update or delete policy, so neither is ever permitted;
-- the rewrite rules in 0007 are the second lock on the same door (ARB-014).
create policy events_select_member on public.events
  for select to authenticated using (app.is_member(org_id));
create policy events_insert_operator on public.events
  for insert to authenticated with check (app.can_write(org_id));

-- Anything added later is covered from the moment it exists rather than from the
-- moment someone remembers to write a policy.
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;
