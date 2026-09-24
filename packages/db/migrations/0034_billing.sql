-- 0034 ARB-420: Paystack (ZAR) and Stripe (USD) billing.
--
-- A plan's price per currency, with the provider's own reference for it, is the owner's
-- (docs/02 D-12, B-15), published with the plan in packages/db/seed/plans.json and
-- checked by `validatePlan` before it is written. The shape is
-- { "ZAR": { "amountMinor", "paystackPlanCode" }, "USD": { "amountMinor", "stripePriceId" } };
-- a currency left out is not on sale.
alter table plans add column prices jsonb not null default '{}'::jsonb
  check (jsonb_typeof(prices) = 'object');

-- The grace period after a failed payment (D-070), one setting for the whole product,
-- written by the seed from plans.json. Null until the owner chooses it: a failed payment
-- then leaves the plan in use until the provider itself ends the subscription.
create table billing_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique check (singleton),
  grace_days integer check (grace_days >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into billing_settings (singleton) values (true);
create trigger billing_settings_updated_at before update on billing_settings
  for each row execute function set_updated_at();
alter table billing_settings enable row level security;
revoke insert, update, delete on billing_settings from authenticated;
create policy billing_settings_select_all on billing_settings
  for select to authenticated using (true);

-- What the provider knows the subscription by, and when a grace period ends.
alter table subscriptions
  add column currency char(3) check (currency in ('ZAR', 'USD')),
  add column external_customer text,
  add column grace_until timestamptz;
create unique index subscriptions_provider_ref_idx on subscriptions (provider, external_ref)
  where external_ref is not null;
create index subscriptions_grace_idx on subscriptions (grace_until) where status = 'past_due';

-- One row per checkout an owner starts: the plan and currency asked for, and our
-- reference, which is what the provider's webhook brings back (Paystack's `reference`,
-- Stripe's `client_reference_id`). An owner starts one; only the system moves it on.
create table billing_checkouts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  provider text not null check (provider in ('paystack', 'stripe')),
  plan_code text not null,
  currency char(3) not null check (currency in ('ZAR', 'USD')),
  reference text not null unique check (reference ~ '^[A-Za-z0-9.=-]+$'),
  external_session_id text,
  status text not null default 'open' check (status in ('open', 'completed', 'failed')),
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index billing_checkouts_org_idx on billing_checkouts (org_id, created_at desc);
create trigger billing_checkouts_updated_at before update on billing_checkouts
  for each row execute function set_updated_at();
alter table billing_checkouts enable row level security;
create policy billing_checkouts_select_member on billing_checkouts
  for select to authenticated using (app.is_member(org_id));
create policy billing_checkouts_insert_owner on billing_checkouts
  for insert to authenticated with check (app.is_owner(org_id));

-- Every webhook delivery the API accepted, keyed so a redelivery is recognised and not
-- applied twice: Stripe's event id; for Paystack, whose events carry no id, a digest of
-- the signed body. The system's alone: no policy for `authenticated`.
create table billing_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('paystack', 'stripe')),
  event_key text not null,
  event_type text not null,
  org_id uuid references orgs (id) on delete set null,
  outcome text not null check (outcome in ('ok', 'skipped', 'error')),
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, event_key)
);
create trigger billing_webhook_receipts_updated_at before update on billing_webhook_receipts
  for each row execute function set_updated_at();
alter table billing_webhook_receipts enable row level security;
revoke all on billing_webhook_receipts from authenticated;
