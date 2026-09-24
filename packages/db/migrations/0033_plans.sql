-- 0033 ARB-410: plans, the house org, and counters only the system writes.
--
-- A plan is platform data, like the category taxonomy: published by the owner of the
-- product in packages/db/seed/plans.json and applied by the seed under service_role. Its
-- limits are the owner's figures (docs/02 D-12), so the seed ships none. Each org's plan
-- is `subscriptions.plan`, a plan code; ARB-420's checkout writes it.

create table plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  -- One monthly limit per metered action (`PLAN_METRICS` in @arbitron/core): a whole
  -- number, or null for no limit. Checked by the seed's validator before it is written.
  limits jsonb not null check (jsonb_typeof(limits) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger plans_updated_at before update on plans
  for each row execute function set_updated_at();

alter table plans enable row level security;
revoke insert, update, delete on plans from authenticated;
create policy plans_select_all on plans for select to authenticated using (true);

-- The house org (D-069): the operator's own organisation, counted but never limited or
-- billed. Every org that exists when this runs predates public sign-up (ARB-400), so it
-- is the house org; every org made later, by `app.create_org`, is not.
alter table orgs add column billing_exempt boolean not null default false;
update orgs set billing_exempt = true;

-- An owner may rename their org (0008) but not exempt it from billing: the update grant
-- is narrowed to the columns an owner may change.
revoke update on orgs from authenticated;
grant update (name, country_code, base_currency) on orgs to authenticated;

-- Subscriptions and usage counters are the system's to write: the checkout and its
-- webhooks (ARB-420) and the workers that take a metered action. 0008 let an owner
-- write them, which would let an owner choose their own plan or wind back a counter.
-- Members keep reading them. With no write policy left for `authenticated`, RLS refuses
-- every insert and matches no row for an update or delete.
drop policy subscriptions_insert_owner on subscriptions;
drop policy subscriptions_update_owner on subscriptions;
drop policy subscriptions_delete_owner on subscriptions;
drop policy usage_counters_insert_owner on usage_counters;
drop policy usage_counters_update_owner on usage_counters;
drop policy usage_counters_delete_owner on usage_counters;
