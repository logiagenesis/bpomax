-- 0023 ARB-201: the ranking that put a candidate on a sourcing request, and the suppliers
-- left out with the reason, kept with the request so the page explains what it shows.
alter table supplier_candidates add column ranking jsonb not null default '{}'::jsonb;
alter table sourcing_requests add column excluded jsonb not null default '[]'::jsonb;
