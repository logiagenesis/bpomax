-- 0027 ARB-311: what each payment is, so realised margin reads as docs/05 section 3.5 has
-- it: payments in − payments out − fees. A client pays in; a supplier, a platform fee or
-- another cost is paid out. A supplier payment is against a delivery order, and may name
-- the milestone it pays.
create type payment_kind as enum ('client', 'supplier', 'platform_fee', 'other_cost');

alter table payments
  add column kind payment_kind,
  add column milestone_index integer check (milestone_index >= 0),
  add column recorded_by uuid references users (id) on delete set null,
  add column note text;

-- No payments exist before this ticket; any that did are read by their direction only.
update payments set kind = case when direction = 'in' then 'client' else 'other_cost' end::payment_kind;
alter table payments alter column kind set not null;

alter table payments add constraint payment_kind_matches_direction
  check ((kind = 'client') = (direction = 'in'));
alter table payments add constraint supplier_payment_has_an_order
  check (kind <> 'supplier' or delivery_order_id is not null);
alter table payments add constraint milestone_only_on_a_supplier_payment
  check (milestone_index is null or kind = 'supplier');

create index payments_pipeline_item_idx on payments (pipeline_item_id);
