-- 0012 the category the estimate worker assigns to a job (ARB-040, docs/01 section E)

-- The estimate worker "classifies category" before it prices. The result is kept on the
-- job so that it is paid for once: a redelivered job, a later reprice, or a feed page
-- reads it back instead of asking the model again. Confidence is the model's own, 0–1.
alter table jobs
  add column category_slug text references service_categories (slug) on delete set null,
  add column category_confidence numeric(4, 3) check (category_confidence between 0 and 1);

create index jobs_org_category_idx on jobs (org_id, category_slug);
