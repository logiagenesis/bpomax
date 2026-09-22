-- 0016 the Telegram bot's state (ARB-050, docs/01 sections H and I)

-- Linking a chat to a person: the web app issues a one-time code (docs/01 section I,
-- "Telegram link" in settings) and the person sends it to the bot with /start. The code
-- is short-lived and used once; what it produces is users.telegram_chat_id.
create table telegram_link_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  code text not null unique check (length(code) between 6 and 32),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index telegram_link_codes_user_idx on telegram_link_codes (user_id);

-- A chat that has been asked for text: after Edit, the next message is the new bid
-- body; after Reject, it is the reason. One pending action per chat, replaced by the
-- next button press.
create table telegram_pending (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  chat_id text not null unique,
  action text not null check (action in ('edit', 'reject')),
  proposal_id uuid not null references proposals (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- /pause and /resume (docs/01 section I): while paused nothing is submitted, whoever
-- approved it; /resume re-queues what was approved in the meantime.
alter table settings
  add column bidding_paused boolean not null default false;

create trigger telegram_link_codes_updated_at before update on telegram_link_codes
  for each row execute function set_updated_at();
create trigger telegram_pending_updated_at before update on telegram_pending
  for each row execute function set_updated_at();

-- Same shape as every other tenant table (0008): members read, operators write. The
-- bot itself acts under service_role.
alter table telegram_link_codes enable row level security;
alter table telegram_pending enable row level security;

create policy telegram_link_codes_select_member on public.telegram_link_codes
  for select to authenticated using (app.is_member(org_id));
create policy telegram_link_codes_insert_operator on public.telegram_link_codes
  for insert to authenticated with check (app.can_write(org_id));
create policy telegram_link_codes_update_operator on public.telegram_link_codes
  for update to authenticated using (app.can_write(org_id)) with check (app.can_write(org_id));
create policy telegram_link_codes_delete_operator on public.telegram_link_codes
  for delete to authenticated using (app.can_write(org_id));

create policy telegram_pending_select_member on public.telegram_pending
  for select to authenticated using (app.is_member(org_id));
create policy telegram_pending_insert_operator on public.telegram_pending
  for insert to authenticated with check (app.can_write(org_id));
create policy telegram_pending_update_operator on public.telegram_pending
  for update to authenticated using (app.can_write(org_id)) with check (app.can_write(org_id));
create policy telegram_pending_delete_operator on public.telegram_pending
  for delete to authenticated using (app.can_write(org_id));
