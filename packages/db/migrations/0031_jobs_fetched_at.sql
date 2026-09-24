-- 0031 ARB-300: when a listing's marketplace data was last fetched (D-066).
-- Upwork's terms allow no caching or storing of their data for more than 24 hours
-- ("Caching is not allowed for more than 24 hours according to our Terms of Service",
-- https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#getting-started-application-permissions),
-- so an Upwork job not fetched again within 24 hours is deleted by the ingest's sync.
-- Every ingest sets it on insert and on each refresh; `updated_at` would not do, since
-- the org's own edits (a category, a scanner) move it too.
alter table jobs add column fetched_at timestamptz not null default now();
create index jobs_platform_fetched_idx on jobs (platform, fetched_at);
