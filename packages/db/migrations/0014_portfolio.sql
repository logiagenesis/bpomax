-- 0014 portfolio items and the proposals that cite them (ARB-043, docs/01 section H)

-- "No fabricated portfolio items, no copied work samples. Portfolio items must be
-- flagged own_work or labelled_demo." Items are the owner's rows (docs/02 D-10), each
-- with permission to show recorded; a draft may cite only rows here, and the citation is
-- a foreign key, so a proposal cannot point at work that does not exist.
create type portfolio_kind as enum ('own_work', 'labelled_demo');

create table portfolio_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  url text,
  description text,
  category_slug text references service_categories (slug) on delete set null,
  kind portfolio_kind not null,
  -- D-10 asks for permission to show; an item without it is never offered to a draft.
  permission_to_show boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, title)
);

create index portfolio_items_org_category_idx on portfolio_items (org_id, category_slug);

create trigger portfolio_items_updated_at before update on portfolio_items
  for each row execute function set_updated_at();

-- Which items a proposal cites. Restrict, not cascade, on the item: a cited item is part
-- of a proposal's record and cannot quietly disappear from under it.
create table proposal_citations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  portfolio_item_id uuid not null references portfolio_items (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proposal_id, portfolio_item_id)
);

create trigger proposal_citations_updated_at before update on proposal_citations
  for each row execute function set_updated_at();

-- Same shape as every other tenant table (0008): members read, operators write.
alter table portfolio_items enable row level security;
alter table proposal_citations enable row level security;

create policy portfolio_items_select_member on public.portfolio_items
  for select to authenticated using (app.is_member(org_id));
create policy portfolio_items_insert_operator on public.portfolio_items
  for insert to authenticated with check (app.can_write(org_id));
create policy portfolio_items_update_operator on public.portfolio_items
  for update to authenticated using (app.can_write(org_id)) with check (app.can_write(org_id));
create policy portfolio_items_delete_operator on public.portfolio_items
  for delete to authenticated using (app.can_write(org_id));

create policy proposal_citations_select_member on public.proposal_citations
  for select to authenticated using (app.is_member(org_id));
create policy proposal_citations_insert_operator on public.proposal_citations
  for insert to authenticated with check (app.can_write(org_id));
create policy proposal_citations_update_operator on public.proposal_citations
  for update to authenticated using (app.can_write(org_id)) with check (app.can_write(org_id));
create policy proposal_citations_delete_operator on public.proposal_citations
  for delete to authenticated using (app.can_write(org_id));
