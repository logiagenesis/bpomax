-- 0004 sourcing and delivery pricing (docs/01 section D)

create table service_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  -- Set by the owner per D-04: categories Logi-Ink delivers itself and never sources out.
  in_house boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type price_band_source as enum ('seed', 'marketplace_sample', 'owner_csv', 'completed_projects');

create table market_price_bands (
  id uuid primary key default gen_random_uuid(),
  category_slug text not null references service_categories (slug) on delete cascade,
  currency char(3) not null,
  p25_minor bigint not null check (p25_minor >= 0),
  p50_minor bigint not null check (p50_minor >= 0),
  p75_minor bigint not null check (p75_minor >= 0),
  sample_size integer not null default 0 check (sample_size >= 0),
  -- Seed rows are flagged so the interface can label them as estimates, not observations
  -- (ARB-013 acceptance).
  source price_band_source not null,
  sampled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (category_slug, currency, source),
  constraint percentiles_ordered check (p25_minor <= p50_minor and p50_minor <= p75_minor)
);

create type supplier_channel as enum (
  'freelancer', 'upwork', 'fiverr', 'direct', 'in_house', 'ai_build'
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  country_code char(2),
  time_zone text,
  channel supplier_channel not null,
  languages text[] not null default '{}',
  quality_score numeric(4, 2) check (quality_score between 0 and 100),
  on_time_rate numeric(4, 3) check (on_time_rate between 0 and 1),
  -- Whether the supplier accepts payment after delivery: the zero-working-capital
  -- model in reference/R2 section 3.6.
  pays_after_delivery boolean not null default false,
  external_profile_url text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table supplier_rate_cards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  supplier_id uuid not null references suppliers (id) on delete cascade,
  category_slug text not null references service_categories (slug) on delete cascade,
  currency char(3) not null,
  fixed_price_minor bigint check (fixed_price_minor >= 0),
  hourly_rate_minor bigint check (hourly_rate_minor >= 0),
  turnaround_days integer check (turnaround_days >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_id, category_slug, currency),
  constraint rate_card_has_a_price check (
    fixed_price_minor is not null or hourly_rate_minor is not null
  )
);

create type sourcing_status as enum ('open', 'shortlisting', 'chosen', 'closed', 'abandoned');

create table sourcing_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  brief_id uuid not null references briefs (id) on delete cascade,
  channels supplier_channel[] not null default '{}',
  status sourcing_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type sourcing_post_status as enum ('draft', 'approved', 'posted', 'closed', 'failed');

create table sourcing_posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  sourcing_request_id uuid not null references sourcing_requests (id) on delete cascade,
  platform platform not null,
  -- Scope only. Never carries client-identifying data (ARB-202 acceptance).
  body text not null,
  budget_min_minor bigint check (budget_min_minor >= 0),
  budget_max_minor bigint check (budget_max_minor >= 0),
  currency char(3),
  status sourcing_post_status not null default 'draft',
  approved_by uuid references users (id) on delete set null,
  approved_via approval_channel,
  external_id text,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint posting_requires_approval check (
    status <> 'posted' or (approved_by is not null and approved_via is not null)
  )
);

create table supplier_candidates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  sourcing_request_id uuid not null references sourcing_requests (id) on delete cascade,
  supplier_id uuid references suppliers (id) on delete set null,
  external_profile_url text,
  display_name text not null,
  country_code char(2),
  quoted_price_minor bigint check (quoted_price_minor >= 0),
  currency char(3),
  turnaround_days integer check (turnaround_days >= 0),
  score numeric(5, 2) check (score between 0 and 100),
  shortlisted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint candidate_is_identifiable check (
    supplier_id is not null or external_profile_url is not null
  )
);

create type estimate_method as enum (
  'in_house', 'rate_card', 'market_band', 'candidate_quote', 'ai_build'
);

create table delivery_estimates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  job_id uuid references jobs (id) on delete cascade,
  brief_id uuid references briefs (id) on delete cascade,
  category_slug text references service_categories (slug) on delete set null,
  -- Every estimate records how it was reached, so a number on screen can always be
  -- traced back to a rate card, a band, a quote or an in-house rate (05 section 3.3).
  method estimate_method not null,
  currency char(3) not null,
  low_minor bigint not null check (low_minor >= 0),
  expected_minor bigint not null check (expected_minor >= 0),
  high_minor bigint not null check (high_minor >= 0),
  turnaround_days integer check (turnaround_days >= 0),
  supplier_id uuid references suppliers (id) on delete set null,
  supplier_candidate_id uuid references supplier_candidates (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint estimate_range_ordered check (low_minor <= expected_minor and expected_minor <= high_minor),
  constraint estimate_has_a_subject check (job_id is not null or brief_id is not null)
);

create index delivery_estimates_job_idx on delivery_estimates (job_id);

create trigger service_categories_updated_at before update on service_categories
  for each row execute function set_updated_at();
create trigger market_price_bands_updated_at before update on market_price_bands
  for each row execute function set_updated_at();
create trigger suppliers_updated_at before update on suppliers
  for each row execute function set_updated_at();
create trigger supplier_rate_cards_updated_at before update on supplier_rate_cards
  for each row execute function set_updated_at();
create trigger sourcing_requests_updated_at before update on sourcing_requests
  for each row execute function set_updated_at();
create trigger sourcing_posts_updated_at before update on sourcing_posts
  for each row execute function set_updated_at();
create trigger supplier_candidates_updated_at before update on supplier_candidates
  for each row execute function set_updated_at();
create trigger delivery_estimates_updated_at before update on delivery_estimates
  for each row execute function set_updated_at();
