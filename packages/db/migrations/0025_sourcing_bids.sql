-- 0025 ARB-203: a Freelancer.com post's failure, and the bids it collects as candidates.
alter table sourcing_posts add column failure_reason text;

alter table supplier_candidates
  add column sourcing_post_id uuid references sourcing_posts (id) on delete set null,
  add column external_bid_id text;

-- A bid is stored once per request; a later read of the same bid updates it.
create unique index supplier_candidates_request_bid_idx
  on supplier_candidates (sourcing_request_id, external_bid_id)
  where external_bid_id is not null;

-- A candidate from a marketplace bid is identified by the bid itself.
alter table supplier_candidates drop constraint candidate_is_identifiable;
alter table supplier_candidates add constraint candidate_is_identifiable check (
  supplier_id is not null or external_profile_url is not null or external_bid_id is not null
);
