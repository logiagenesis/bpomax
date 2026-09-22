-- 0006 templates, variants and auto-replies (docs/01 section D)

create table templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  category_slug text references service_categories (slug) on delete set null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

create table template_variants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  template_id uuid not null references templates (id) on delete cascade,
  label text not null,
  body text not null,
  active boolean not null default true,
  -- Counters, not a stored rate: reply rate is replies / sends, computed where it is
  -- shown and verified against raw SQL in tests (ARB-340 acceptance).
  sends integer not null default 0 check (sends >= 0),
  replies integer not null default 0 check (replies >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id, label),
  constraint replies_cannot_exceed_sends check (replies <= sends)
);

alter table proposals
  add constraint proposals_template_variant_fk
  foreign key (template_variant_id) references template_variants (id) on delete set null;

create table auto_replies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  name text not null,
  body text not null,
  active boolean not null default false,
  -- Only fires while the operator is offline, and only once per thread (ARB-121).
  offline_after_minutes integer not null default 30 check (offline_after_minutes > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);

-- One auto-reply per thread, ever. A unique index is the guarantee; the worker checks
-- it too, but the database is what makes a second one impossible (ARB-121 acceptance).
create table auto_reply_sends (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  thread_id uuid not null references threads (id) on delete cascade,
  auto_reply_id uuid not null references auto_replies (id) on delete cascade,
  message_id uuid references messages (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (thread_id)
);

create trigger templates_updated_at before update on templates
  for each row execute function set_updated_at();
create trigger template_variants_updated_at before update on template_variants
  for each row execute function set_updated_at();
create trigger auto_replies_updated_at before update on auto_replies
  for each row execute function set_updated_at();
create trigger auto_reply_sends_updated_at before update on auto_reply_sends
  for each row execute function set_updated_at();
