-- 0036 security fixes from the owner's audit LI-AUDIT-BPOMAX-TASKS-20260925 (ARB-500)

-- S-01. A Telegram link code links a chat to the person it names, and whoever sends the
-- code to the bot then acts as that person. 0016 gave link codes the ordinary tenant
-- shape (members read, operators write), so an operator could write a code naming the
-- owner, or read one the owner had just made, and take over the owner's approvals from
-- Telegram. A code is now the business of the person it names alone: written only for
-- yourself, read only by yourself, and never changed from the application at all. The
-- bot marks a code used under service_role (apps/telegram), atomically, so a code links
-- one chat once.
drop policy telegram_link_codes_select_member on public.telegram_link_codes;
drop policy telegram_link_codes_insert_operator on public.telegram_link_codes;
drop policy telegram_link_codes_update_operator on public.telegram_link_codes;
drop policy telegram_link_codes_delete_operator on public.telegram_link_codes;

create policy telegram_link_codes_select_own on public.telegram_link_codes
  for select to authenticated
  using (
    app.is_member(org_id)
    and user_id = app.current_user_id()
  );
create policy telegram_link_codes_insert_own on public.telegram_link_codes
  for insert to authenticated
  with check (
    app.can_write(org_id)
    and user_id = app.current_user_id()
    and used_at is null
  );
create policy telegram_link_codes_delete_own on public.telegram_link_codes
  for delete to authenticated
  using (
    app.is_member(org_id)
    and user_id = app.current_user_id()
  );

-- The same reasoning for the bot's own state: a pending Edit or Reject turns a chat's
-- next message into a bid's text or a rejection reason. Only the bot writes it, under
-- service_role; a member may still read their org's rows.
drop policy telegram_pending_insert_operator on public.telegram_pending;
drop policy telegram_pending_update_operator on public.telegram_pending;
drop policy telegram_pending_delete_operator on public.telegram_pending;

-- S-02. A supplier's profile link is shown as a link. The import already accepts only
-- http and https (packages/core/src/suppliers.ts); the database now refuses anything
-- else however the row is written, so a `javascript:` address can never reach a page.
alter table suppliers
  add constraint suppliers_profile_url_is_web
  check (external_profile_url is null or external_profile_url ~* '^https?://');
alter table supplier_candidates
  add constraint supplier_candidates_profile_url_is_web
  check (external_profile_url is null or external_profile_url ~* '^https?://');
