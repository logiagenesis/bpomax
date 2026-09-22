-- 0002 marketplace: accounts, scanners, jobs, scores (docs/01 section D)

create type platform as enum ('freelancer', 'upwork', 'fiverr');
create type platform_account_status as enum ('connected', 'expired', 'revoked', 'error');

create table platform_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  platform platform not null,
  external_user_id text not null,
  -- Tokens are encrypted at rest with pgsodium and are never selected into the app
  -- unless a worker is about to make a call. Never logged (05 section 4.3).
  access_token_encrypted bytea,
  refresh_token_encrypted bytea,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status platform_account_status not null default 'connected',
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One account per platform per verified identity (01 section H). Enforced two ways:
  -- one row per org and platform, and one row per platform and external user.
  unique (org_id, platform),
  unique (platform, external_user_id)
);

create table scanners (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  platform platform not null default 'freelancer',
  filters jsonb not null default '{}'::jsonb,
  poll_interval_seconds integer not null default 120 check (poll_interval_seconds >= 60),
  active boolean not null default true,
  -- Auto-send is off by default and always capped (01 section H).
  auto_send boolean not null default false,
  min_score integer check (min_score between 0 and 100),
  daily_cap integer not null default 0 check (daily_cap >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name),
  -- Auto-send without a cap and a score floor is exactly the silent mass bidding
  -- R1 section 7 warns about. The database refuses it.
  constraint auto_send_requires_guardrails check (
    not auto_send or (daily_cap > 0 and min_score is not null)
  )
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  platform platform not null,
  external_id text not null,
  raw jsonb not null,
  title text not null,
  description text,
  budget_min_minor bigint check (budget_min_minor >= 0),
  budget_max_minor bigint check (budget_max_minor >= 0),
  currency char(3),
  hourly boolean not null default false,
  skills text[] not null default '{}',
  client_country char(2),
  client_payment_verified boolean,
  client_spend_minor bigint check (client_spend_minor >= 0),
  client_rating numeric(3, 2) check (client_rating between 0 and 5),
  bid_count integer check (bid_count >= 0),
  average_bid_minor bigint check (average_bid_minor >= 0),
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Dedupe key for the ingest worker (ARB-022).
  unique (platform, external_id),
  constraint budget_range_ordered check (
    budget_min_minor is null
    or budget_max_minor is null
    or budget_min_minor <= budget_max_minor
  ),
  constraint budget_needs_currency check (
    (budget_min_minor is null and budget_max_minor is null) or currency is not null
  )
);

create index jobs_org_first_seen_idx on jobs (org_id, first_seen_at desc);
create index jobs_org_posted_idx on jobs (org_id, posted_at desc);

create type score_verdict as enum ('go', 'caution', 'skip');

create table job_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  job_id uuid not null references jobs (id) on delete cascade,
  score integer not null check (score between 0 and 100),
  verdict score_verdict not null,
  reasons text[] not null default '{}',
  flags text[] not null default '{}',
  reply_probability numeric(4, 3) check (reply_probability between 0 and 1),
  model text not null,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  -- Cost of this call in USD minor units, from the price table in config.
  cost_usd_minor bigint check (cost_usd_minor >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index job_scores_job_idx on job_scores (job_id);
create index job_scores_org_verdict_idx on job_scores (org_id, verdict);

create trigger platform_accounts_updated_at before update on platform_accounts
  for each row execute function set_updated_at();
create trigger scanners_updated_at before update on scanners
  for each row execute function set_updated_at();
create trigger jobs_updated_at before update on jobs
  for each row execute function set_updated_at();
create trigger job_scores_updated_at before update on job_scores
  for each row execute function set_updated_at();
