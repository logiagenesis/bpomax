-- 0026 ARB-310: delivery orders — the supplier chosen on a sourcing request, the handover
-- checklist read from the brief, and milestones that reconcile to the agreed cost.
alter table delivery_orders
  add column sourcing_request_id uuid references sourcing_requests (id) on delete set null,
  add column supplier_candidate_id uuid references supplier_candidates (id) on delete set null,
  add column handover jsonb not null default '[]'::jsonb,
  add column handed_over_at timestamptz,
  add column accepted_at timestamptz,
  add column cancelled_at timestamptz;

-- The sum of the milestones' amounts, in minor units. Summed as numeric, so it cannot
-- overflow or round; the milestone shape is checked in packages/core before it is written.
create function delivery_milestone_total(milestones jsonb) returns numeric
  language sql immutable
  set search_path = pg_catalog
  as $$
    select coalesce(sum((m ->> 'amountMinor')::numeric), 0)
      from jsonb_array_elements(milestones) as m
  $$;

-- The ticket's acceptance, held by the database too: once an order leaves draft its
-- milestones add up to the agreed cost exactly (a cancelled order keeps what it had).
alter table delivery_orders add constraint milestones_reconcile check (
  status in ('draft', 'cancelled') or (
    agreed_cost_minor is not null
    and currency is not null
    and jsonb_typeof(milestones) = 'array'
    and jsonb_array_length(milestones) > 0
    and delivery_milestone_total(milestones) = agreed_cost_minor
  )
);

-- One live order per job: a cancelled order may be replaced by a new one.
create unique index delivery_orders_one_live_per_item
  on delivery_orders (pipeline_item_id) where status <> 'cancelled';
