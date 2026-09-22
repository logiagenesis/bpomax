-- 0005 money: margin, proposals, pipeline, delivery, payments (docs/01 sections D and G)

create table margin_evaluations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  job_id uuid references jobs (id) on delete cascade,
  brief_id uuid references briefs (id) on delete cascade,
  delivery_estimate_id uuid references delivery_estimates (id) on delete set null,
  currency char(3) not null,
  -- Every input line is stored so any figure on screen can be audited back to its
  -- parts (01 section G, 05 section 3.3). Nothing here is derived at read time.
  client_budget_minor bigint not null check (client_budget_minor >= 0),
  platform_fee_minor bigint not null check (platform_fee_minor >= 0),
  supplier_cost_minor bigint not null check (supplier_cost_minor >= 0),
  fx_buffer_minor bigint not null check (fx_buffer_minor >= 0),
  tool_cost_minor bigint not null default 0 check (tool_cost_minor >= 0),
  margin_minor bigint not null,
  margin_pct numeric(6, 3) not null,
  -- The rule the evaluation was judged against, copied in so a later settings change
  -- cannot silently rewrite history.
  min_margin_pct numeric(6, 3) not null,
  min_margin_zar_minor bigint not null check (min_margin_zar_minor >= 0),
  fx_rate_used numeric(18, 8),
  fx_rate_at timestamptz,
  passed boolean not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint margin_has_a_subject check (job_id is not null or brief_id is not null)
);

create index margin_evaluations_job_idx on margin_evaluations (job_id);

create type proposal_status as enum (
  'draft', 'queued', 'approved', 'rejected', 'submitted', 'failed'
);

create table proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  job_id uuid not null references jobs (id) on delete cascade,
  margin_evaluation_id uuid references margin_evaluations (id) on delete set null,
  template_variant_id uuid,
  body text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  delivery_days integer not null check (delivery_days > 0),
  -- Milestones must sum to amount_minor; enforced in packages/core and asserted in
  -- tests (ARB-043 acceptance, 05 section 3.5).
  milestones jsonb not null default '[]'::jsonb,
  status proposal_status not null default 'draft',
  approved_by uuid references users (id) on delete set null,
  approved_via approval_channel,
  submitted_at timestamptz,
  platform_ref text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Nothing is submitted without an approval record (01 section H, ARB-044).
  constraint submission_requires_approval check (
    status <> 'submitted' or (approved_by is not null and approved_via is not null)
  )
);

create index proposals_org_status_idx on proposals (org_id, status);

create type pipeline_stage as enum (
  'applied', 'replied', 'discovery', 'briefed', 'sourcing',
  'won', 'in_delivery', 'delivered', 'paid', 'lost'
);

create table pipeline_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  job_id uuid not null references jobs (id) on delete cascade,
  proposal_id uuid references proposals (id) on delete set null,
  thread_id uuid references threads (id) on delete set null,
  stage pipeline_stage not null default 'applied',
  value_minor bigint check (value_minor >= 0),
  currency char(3),
  -- Retainers are where the recurring margin lives (reference/R2 section 5).
  retainer boolean not null default false,
  retainer_monthly_minor bigint check (retainer_monthly_minor >= 0),
  stage_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id),
  constraint retainer_has_an_amount check (not retainer or retainer_monthly_minor is not null)
);

create index pipeline_items_org_stage_idx on pipeline_items (org_id, stage);

create type delivery_order_status as enum (
  'draft', 'assigned', 'in_progress', 'delivered', 'accepted', 'cancelled'
);

create table delivery_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  pipeline_item_id uuid not null references pipeline_items (id) on delete cascade,
  supplier_id uuid references suppliers (id) on delete set null,
  brief_id uuid references briefs (id) on delete set null,
  status delivery_order_status not null default 'draft',
  agreed_cost_minor bigint check (agreed_cost_minor >= 0),
  currency char(3),
  milestones jsonb not null default '[]'::jsonb,
  due_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type payment_direction as enum ('in', 'out');

create table payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  pipeline_item_id uuid references pipeline_items (id) on delete set null,
  delivery_order_id uuid references delivery_orders (id) on delete set null,
  direction payment_direction not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  -- The rate actually used, with its timestamp, so a converted figure can be
  -- reproduced exactly (05 section 3.4).
  fx_rate_used numeric(18, 8),
  fx_rate_at timestamptz,
  amount_zar_minor bigint check (amount_zar_minor >= 0),
  paid_at timestamptz,
  reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_has_a_subject check (
    pipeline_item_id is not null or delivery_order_id is not null
  ),
  constraint converted_amount_shows_its_rate check (
    amount_zar_minor is null or currency = 'ZAR' or (fx_rate_used is not null and fx_rate_at is not null)
  )
);

create index payments_org_paid_idx on payments (org_id, paid_at desc);

create trigger margin_evaluations_updated_at before update on margin_evaluations
  for each row execute function set_updated_at();
create trigger proposals_updated_at before update on proposals
  for each row execute function set_updated_at();
create trigger pipeline_items_updated_at before update on pipeline_items
  for each row execute function set_updated_at();
create trigger delivery_orders_updated_at before update on delivery_orders
  for each row execute function set_updated_at();
create trigger payments_updated_at before update on payments
  for each row execute function set_updated_at();
