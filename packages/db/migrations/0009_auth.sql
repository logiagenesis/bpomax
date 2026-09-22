-- 0009 auth wiring and approval integrity (ARB-012, docs/01 sections D and H)
--
-- Supabase owns identity: a person exists in auth.users the moment they verify their
-- email. This migration makes the application's own `users` row follow from that, so
-- there is never an application account without an authenticated identity behind it —
-- which is what makes "one marketplace account per verified identity" (01 section H)
-- something the database can rely on.

-- A new authenticated identity gets exactly one application user, and nothing else.
-- Membership of an org is a separate, deliberate act by an owner (ARB-012, D-13):
-- signing up does not put anyone inside a tenant.
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (auth_user_id, email)
  values (new.id, new.email)
  on conflict (auth_user_id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Losing the identity must not silently orphan the application row; blanking the link
-- keeps the audit trail (events.actor_user_id) intact while denying every policy, all
-- of which match on auth_user_id.
create or replace function public.handle_deleted_auth_user() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.users set auth_user_id = null where auth_user_id = old.id;
  return old;
end;
$$;

create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public.handle_deleted_auth_user();

-- Approval integrity.
--
-- 0008 already decides who may write these tables. What it does not stop is an operator
-- writing someone else's name into the approval. These policies are RESTRICTIVE, so they
-- are ANDed with the permissive ones rather than widening them: whatever else is true,
-- an approval recorded through the application names the person who made it.
--
-- service_role bypasses RLS and is what the auto-reply path uses, where the approval is
-- the operator's standing configuration rather than a person in the moment.
create policy proposals_approval_is_first_person on public.proposals
  as restrictive for update to authenticated
  with check (approved_by is null or approved_by = app.current_user_id());

create policy proposals_approval_is_first_person_insert on public.proposals
  as restrictive for insert to authenticated
  with check (approved_by is null or approved_by = app.current_user_id());

create policy messages_approval_is_first_person on public.messages
  as restrictive for update to authenticated
  with check (approved_by is null or approved_by = app.current_user_id());

create policy messages_approval_is_first_person_insert on public.messages
  as restrictive for insert to authenticated
  with check (approved_by is null or approved_by = app.current_user_id());

create policy sourcing_posts_approval_is_first_person on public.sourcing_posts
  as restrictive for update to authenticated
  with check (approved_by is null or approved_by = app.current_user_id());

create policy sourcing_posts_approval_is_first_person_insert on public.sourcing_posts
  as restrictive for insert to authenticated
  with check (approved_by is null or approved_by = app.current_user_id());

-- An org must keep at least one owner, or its settings and memberships become
-- unreachable from the application for good.
create or replace function public.refuse_last_owner_removal() returns trigger
language plpgsql
as $$
declare
  remaining integer;
  gone_org uuid := old.org_id;
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' and new.org_id = old.org_id then
    return new;
  end if;

  select count(*) into remaining
  from public.memberships
  where org_id = gone_org and role = 'owner' and id <> old.id;

  if remaining = 0 then
    raise exception 'an org must keep at least one owner'
      using errcode = 'check_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger memberships_keep_an_owner
  before update or delete on public.memberships
  for each row execute function public.refuse_last_owner_removal();
