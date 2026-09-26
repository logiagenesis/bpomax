-- 0038 column grants and caller-bound "who" columns, from the owner's audit
-- LI-AUDIT-BPOMAX-TASKS-20260925 S-05 (ARB-502)
--
-- 0008 granted the `authenticated` role insert and update on every column of every
-- table, and row-level security decides which rows. So through the Supabase Data API
-- (PostgREST, reachable with a person's own token) a member could write columns the
-- application never lets them write: their own `users.auth_user_id`, a platform
-- account's Vault secret ids, a bid's platform reference or `submitted` status, an
-- approval in someone else's name, an audit event in someone else's name. Here the
-- columns the application writes as the signed-in person are granted by name, and the
-- "who did it" columns must name the person doing it. Workers and the bot act as
-- service_role and are not affected. Whether the Data API is reachable from browsers at
-- all is the owner's decision (docs/BLOCKERS.md D-19).

-- users: the application never changes a users row as the signed-in person (the bot
-- links Telegram under service_role; sign-up makes the row under service_role).
revoke update on public.users from authenticated;

-- platform_accounts: the connect writes who the account is; settings writes the plan.
-- Never the Vault secret ids, the status or the sync points: those move only through
-- the security-definer token functions (0017) and the workers.
revoke insert, update on public.platform_accounts from authenticated;
grant insert (org_id, platform, external_user_id, external_username, scopes)
  on public.platform_accounts to authenticated;
grant update (external_user_id, external_username, scopes, plan_name, monthly_bid_allowance,
              plan_recorded_on)
  on public.platform_accounts to authenticated;

-- proposals: drafted by the workers only (so a bid always comes from the margin rule),
-- sent by the submit worker only; a person approves, edits or rejects.
revoke insert, update on public.proposals from authenticated;
grant update (body, status, approved_by, approved_via, failure_reason)
  on public.proposals to authenticated;

-- messages: a person drafts, approves, edits or rejects a reply; the sender sends it.
revoke insert, update on public.messages from authenticated;
grant insert (org_id, thread_id, direction, body, origin) on public.messages to authenticated;
grant update (body, approved_by, approved_via, failure_reason, rejected_at)
  on public.messages to authenticated;

-- A bid the signed-in person marks sent would skip the sender, the live gate and the
-- allowance: only the sender (service_role) marks a bid submitted. Restrictive, so it is
-- ANDed with the permissive policies, as 0009's approval policies are.
create policy proposals_not_sent_by_person on public.proposals
  as restrictive for update to authenticated
  with check (status <> 'submitted');

-- "Who did it" columns name the signed-in person, or nobody; never someone else. 0009
-- holds bids, messages and sourcing posts to this; the same rule now covers the other
-- three such columns. Set by the workers or the bot (service_role) they are unchecked.
create policy auto_replies_approval_is_first_person on public.auto_replies
  as restrictive for update to authenticated
  with check (approved_by is null or approved_by = app.current_user_id());
create policy auto_replies_approval_is_first_person_insert on public.auto_replies
  as restrictive for insert to authenticated
  with check (approved_by is null or approved_by = app.current_user_id());
create policy payments_recorded_by_first_person on public.payments
  as restrictive for update to authenticated
  with check (recorded_by is null or recorded_by = app.current_user_id());
create policy payments_recorded_by_first_person_insert on public.payments
  as restrictive for insert to authenticated
  with check (recorded_by is null or recorded_by = app.current_user_id());
create policy billing_checkouts_created_by_first_person on public.billing_checkouts
  as restrictive for update to authenticated
  with check (created_by is null or created_by = app.current_user_id());
create policy billing_checkouts_created_by_first_person_insert on public.billing_checkouts
  as restrictive for insert to authenticated
  with check (created_by is null or created_by = app.current_user_id());

-- The audit log: a person appends events in their own name, or as the system; never in
-- another person's.
drop policy events_insert_operator on public.events;
create policy events_insert_operator on public.events
  for insert to authenticated
  with check (
    app.can_write(org_id)
    and (actor_user_id is null or actor_user_id = app.current_user_id())
  );
