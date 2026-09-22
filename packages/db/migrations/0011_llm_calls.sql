-- 0011 LLM call metering (ARB-031, docs/01 section C)
--
-- docs/01 section D gives job_scores its own token and cost columns, but scoring is not
-- the only thing that calls a model: drafting, discovery and brief building all will.
-- Without one place recording every call there is no answer to "what did last month
-- cost", and ARB-320 has to have one. DECISIONS.md D-021 records the addition.
--
-- Cost is in whole nano-US-dollars. A scoring call costs a fraction of a cent, so cents
-- would round nearly every call to zero and every total would be wrong the same way.

create type llm_purpose as enum (
  'score', 'draft', 'discovery', 'brief', 'estimate', 'other'
);

create type llm_outcome as enum ('ok', 'invalid_output', 'error');

create table llm_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  purpose llm_purpose not null,
  model text not null,
  subject_table text,
  subject_id uuid,
  request_id text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  cost_nano_usd bigint not null default 0 check (cost_nano_usd >= 0),
  -- 1 when the first reply was good, 2 when the retry saved it. Both are charged for.
  attempts integer not null default 1 check (attempts >= 1),
  outcome llm_outcome not null default 'ok',
  -- What the schema validator objected to, when it objected. Never the prompt or the
  -- reply: those can carry client content, and this table is kept for years.
  problems jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index llm_calls_org_created_idx on llm_calls (org_id, created_at desc);
create index llm_calls_subject_idx on llm_calls (subject_table, subject_id);
create index llm_calls_purpose_idx on llm_calls (org_id, purpose);

create trigger llm_calls_updated_at before update on llm_calls
  for each row execute function set_updated_at();

-- Same shape as every other tenant table (0008): members read, operators write.
alter table llm_calls enable row level security;

create policy llm_calls_select_member on public.llm_calls
  for select to authenticated using (app.is_member(org_id));
create policy llm_calls_insert_operator on public.llm_calls
  for insert to authenticated with check (app.can_write(org_id));
create policy llm_calls_update_operator on public.llm_calls
  for update to authenticated using (app.can_write(org_id)) with check (app.can_write(org_id));
create policy llm_calls_delete_operator on public.llm_calls
  for delete to authenticated using (app.can_write(org_id));
