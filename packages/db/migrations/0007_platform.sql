-- 0007 platform: events, settings, and the Phase 4 billing tables (docs/01 section D)

-- Append-only audit log of every state change and external call (01 section D,
-- 05 section 4.5). No update or delete trigger: rows are written once.
create table events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs (id) on delete cascade,
  actor_user_id uuid references users (id) on delete set null,
  -- 'system' for worker actions with no human actor.
  actor_kind text not null default 'system' check (actor_kind in ('user', 'system')),
  type text not null check (length(trim(type)) > 0),
  subject_table text,
  subject_id uuid,
  request_id text,
  outcome text check (outcome in ('ok', 'error', 'blocked', 'skipped')),
  -- What would have been sent when LIVE_MODE is false (01 section H).
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index events_org_created_idx on events (org_id, created_at desc);
create index events_type_idx on events (type);
create index events_subject_idx on events (subject_table, subject_id);

create rule events_no_update as on update to events do instead nothing;
create rule events_no_delete as on delete to events do instead nothing;

create table settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  -- No defaults are invented for any of these. They are null until the owner supplies
  -- them (docs/02 D-02, D-03, T-02), and live mode is refused while they are.
  min_margin_pct numeric(6, 3) check (min_margin_pct >= 0),
  min_margin_zar_minor bigint check (min_margin_zar_minor >= 0),
  fx_buffer_pct numeric(6, 3) check (fx_buffer_pct >= 0),
  vat_pct numeric(6, 3) not null default 15.000 check (vat_pct >= 0),
  -- Fee table per platform and project type, each row carrying the official fee page
  -- URL and the date it was read (01 section G, 05 section 5.2).
  fee_table jsonb not null default '[]'::jsonb,
  live_mode boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id),
  -- Live mode cannot be switched on while a margin rule is missing. The operator has
  -- to answer D-02, D-03 and T-02 first.
  constraint live_mode_requires_margin_rules check (
    not live_mode or (
      min_margin_pct is not null
      and min_margin_zar_minor is not null
      and fx_buffer_pct is not null
      and jsonb_array_length(fee_table) > 0
    )
  )
);

-- Phase 4. Created now so the schema is whole; nothing reads them until ARB-400.
create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  plan text not null,
  status text not null default 'trialing'
    check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  provider text check (provider in ('paystack', 'stripe')),
  external_ref text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id)
);

create table usage_counters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  metric text not null,
  period_start date not null,
  used integer not null default 0 check (used >= 0),
  limit_value integer check (limit_value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, metric, period_start)
);

create table affiliates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs (id) on delete set null,
  code text not null unique,
  owner_email text,
  commission_pct numeric(6, 3) check (commission_pct between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table attribution (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs (id) on delete cascade,
  affiliate_id uuid references affiliates (id) on delete set null,
  source text,
  first_seen_at timestamptz not null default now(),
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger settings_updated_at before update on settings
  for each row execute function set_updated_at();
create trigger subscriptions_updated_at before update on subscriptions
  for each row execute function set_updated_at();
create trigger usage_counters_updated_at before update on usage_counters
  for each row execute function set_updated_at();
create trigger affiliates_updated_at before update on affiliates
  for each row execute function set_updated_at();
create trigger attribution_updated_at before update on attribution
  for each row execute function set_updated_at();
