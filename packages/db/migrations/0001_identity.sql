-- 0001 identity and tenancy (docs/01 section D)
-- Conventions for every table in this schema:
--   * uuid primary key, default gen_random_uuid()
--   * org_id on everything tenant-scoped, referencing orgs(id)
--   * created_at / updated_at, both timestamptz, stored in UTC
--   * money as integer minor units (bigint) plus an ISO 4217 currency code
-- Row level security policies are added in 0008 (ARB-011), not here.

-- gen_random_uuid() is core Postgres since 13; pgcrypto is not needed for it.

-- Touch updated_at on every update. Attached to each table at the end of its migration.
create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  country_code char(2) not null default 'ZA',
  -- Display currency for the operator. Deal currencies are stored per row.
  base_currency char(3) not null default 'ZAR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type user_role as enum ('owner', 'operator', 'viewer');

create table users (
  id uuid primary key default gen_random_uuid(),
  -- Supabase auth.users.id. Nullable so an operator can be invited before first login.
  auth_user_id uuid unique,
  email text,
  full_name text,
  telegram_chat_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role user_role not null default 'operator',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create unique index users_email_lower_idx on users (lower(email));
create index memberships_user_idx on memberships (user_id);
create index memberships_org_idx on memberships (org_id);

create trigger orgs_updated_at before update on orgs
  for each row execute function set_updated_at();
create trigger users_updated_at before update on users
  for each row execute function set_updated_at();
create trigger memberships_updated_at before update on memberships
  for each row execute function set_updated_at();
