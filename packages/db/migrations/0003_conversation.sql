-- 0003 conversation, discovery and brief (docs/01 sections D and F)

create type thread_status as enum ('open', 'awaiting_client', 'awaiting_operator', 'closed');
create type message_direction as enum ('in', 'out');
create type approval_channel as enum ('telegram', 'web', 'auto');

create table threads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  job_id uuid references jobs (id) on delete set null,
  platform platform not null,
  external_thread_id text not null,
  client_handle text,
  status thread_status not null default 'open',
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_thread_id)
);

create index threads_org_last_message_idx on threads (org_id, last_message_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  thread_id uuid not null references threads (id) on delete cascade,
  direction message_direction not null,
  body text not null,
  sent_at timestamptz,
  approved_by uuid references users (id) on delete set null,
  approved_via approval_channel,
  external_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Nothing outbound leaves without an approval record (01 section H, ARB-122).
  constraint outbound_requires_approval check (
    direction = 'in' or sent_at is null or (approved_by is not null and approved_via is not null)
  )
);

create index messages_thread_idx on messages (thread_id, created_at);

create table discovery_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  thread_id uuid not null references threads (id) on delete cascade,
  question_set_version text not null,
  answers jsonb not null default '{}'::jsonb,
  completeness numeric(5, 2) not null default 0 check (completeness between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (thread_id, question_set_version)
);

create type delivery_route as enum ('in_house', 'ai_build', 'supplier', 'source_new');
create type budget_type as enum ('fixed', 'hourly');

create table briefs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  thread_id uuid not null references threads (id) on delete cascade,
  version integer not null default 1 check (version >= 1),
  locked boolean not null default false,
  locked_at timestamptz,
  -- Structured requirements. Shape is validated in packages/core against the
  -- brief schema (01 section F) before anything is written here.
  title text not null,
  outcome text not null,
  users text,
  must_haves text[] not null default '{}',
  later text[] not null default '{}',
  references_ text[] not null default '{}',
  assets_provided text[] not null default '{}',
  assets_missing text[] not null default '{}',
  tech_constraints text[] not null default '{}',
  deadline date,
  deadline_fixed boolean,
  budget_min_minor bigint check (budget_min_minor >= 0),
  budget_max_minor bigint check (budget_max_minor >= 0),
  budget_currency char(3),
  budget_type budget_type,
  acceptance_criteria text[] not null default '{}',
  sign_off_name text,
  sign_off_response_time text,
  risks text[] not null default '{}',
  category_slug text,
  delivery_route delivery_route,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (thread_id, version),
  -- A locked brief must carry the fields the sourcing and pricing path reads (ARB-131).
  constraint locked_brief_is_complete check (
    not locked or (
      category_slug is not null
      and delivery_route is not null
      and array_length(must_haves, 1) >= 1
      and array_length(acceptance_criteria, 1) >= 1
      and locked_at is not null
    )
  )
);

create index briefs_org_idx on briefs (org_id);

create trigger threads_updated_at before update on threads
  for each row execute function set_updated_at();
create trigger messages_updated_at before update on messages
  for each row execute function set_updated_at();
create trigger discovery_sessions_updated_at before update on discovery_sessions
  for each row execute function set_updated_at();
create trigger briefs_updated_at before update on briefs
  for each row execute function set_updated_at();
